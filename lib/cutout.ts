import sharp from "sharp";

/**
 * Mask-to-cutout helpers (sharp, server-side).
 *
 * Box-relative mapping adapted from Meta's MIT-licensed cookbook:
 *   https://github.com/meta-models/meta-model-cookbook/tree/main/07_sam/02_video_to_sticker_pack
 * (create-segmented-gif.mjs: mask raster scaled into the box, transparent
 * alpha cutout + crop to box). Ported from spikes/01-sam-cutout.ts.
 * Masks are relative to their box (spike 01 verdict: 13/13 box-relative).
 */

export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MaskSource {
  box: PixelBox;
  raster: ArrayLike<number>;
  maskWidth: number;
  maskHeight: number;
}

/**
 * Fill enclosed holes in a binary mask raster (1 = garment, 0 = background).
 * Flood-fills the background from the raster border through 4-connected
 * zeros; any zero pixel the flood cannot reach (a tag, logo, or print fully
 * inside the garment) becomes garment. Border-connected zeros stay 0.
 * Returns a NEW Uint8Array; the input is not mutated.
 */
export function fillEnclosedHoles(
  raster: ArrayLike<number>,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) out[i] = raster[i] === 1 ? 1 : 0;

  const reached = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x += 1) {
    if (out[x] === 0) stack.push(x);
    const bottom = (height - 1) * width + x;
    if (out[bottom] === 0) stack.push(bottom);
  }
  for (let y = 0; y < height; y += 1) {
    if (out[y * width] === 0) stack.push(y * width);
    if (out[y * width + width - 1] === 0) stack.push(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (reached[i] === 1 || out[i] === 1) continue;
    reached[i] = 1;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - width);
    if (y < height - 1) stack.push(i + width);
  }
  for (let i = 0; i < width * height; i += 1) {
    if (out[i] === 0 && reached[i] === 0) out[i] = 1;
  }
  return out;
}

/** Fraction of the image covered by filled mask pixels. */
export function filledAreaFraction(
  filled: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
): number {
  if (imageWidth <= 0 || imageHeight <= 0) return 0;
  let fg = 0;
  for (let i = 0; i < filled.length; i += 1) fg += filled[i] === 1 ? 1 : 0;
  return fg / (imageWidth * imageHeight);
}

/** Sample a box-relative raster at image pixel (x, y). Outside the box = 0. */
export function sampleMask(
  raster: ArrayLike<number>,
  maskWidth: number,
  maskHeight: number,
  box: PixelBox,
  x: number,
  y: number,
): boolean {
  if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return false;
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  if (bw <= 0 || bh <= 0) return false;
  const mx = Math.min(maskWidth - 1, Math.floor(((x - box.left) * maskWidth) / bw));
  const my = Math.min(maskHeight - 1, Math.floor(((y - box.top) * maskHeight) / bh));
  return raster[my * maskWidth + mx] === 1;
}

/**
 * Build one union raster over the union box of several detections (used for
 * merged footwear pairs). The union raster is union-box-sized, so each pixel
 * maps 1:1 to its image pixel; a pixel is garment if ANY source mask hits it.
 */
export function buildUnionRaster(sources: MaskSource[], union: PixelBox): Uint8Array {
  const w = Math.max(1, union.right - union.left);
  const h = Math.max(1, union.bottom - union.top);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ix = union.left + x;
      const iy = union.top + y;
      for (const s of sources) {
        if (sampleMask(s.raster, s.maskWidth, s.maskHeight, s.box, ix, iy)) {
          out[y * w + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

export interface CutoutResult {
  /** Transparent PNG bytes, cropped to the (padded) box. */
  png: Buffer;
  /** Fraction of the full image covered by the filled mask. */
  areaFraction: number;
}

/**
 * Flatten a transparent cutout PNG onto a light background and shrink it to
 * at most 512px on the long side for the tagger: small JPEGs tag faster
 * than multi-megapixel PNGs. Never enlarges small cutouts.
 */
export async function flattenForTag(png: Buffer, background = "#f5f5f5"): Promise<Buffer> {
  return sharp(png)
    .flatten({ background })
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const PADDING_RATIO = 0.08;

/**
 * Decode the mask (box-relative) -> fill enclosed holes -> apply as alpha ->
 * crop to the box + padding -> transparent PNG buffer.
 */
export async function makeCutout(
  imageBytes: Buffer,
  imageWidth: number,
  imageHeight: number,
  box: PixelBox,
  raster: ArrayLike<number>,
  maskWidth: number,
  maskHeight: number,
): Promise<CutoutResult> {
  const filled = fillEnclosedHoles(raster, maskWidth, maskHeight);
  const areaFraction = filledAreaFraction(filled, imageWidth, imageHeight);

  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  const padX = Math.round(bw * PADDING_RATIO);
  const padY = Math.round(bh * PADDING_RATIO);
  const crop = {
    left: Math.max(0, box.left - padX),
    top: Math.max(0, box.top - padY),
    right: Math.min(imageWidth, box.right + padX),
    bottom: Math.min(imageHeight, box.bottom + padY),
  };
  const cw = Math.max(1, crop.right - crop.left);
  const ch = Math.max(1, crop.bottom - crop.top);

  const base = await sharp(imageBytes)
    .ensureAlpha()
    .extract({ left: crop.left, top: crop.top, width: cw, height: ch })
    .raw()
    .toBuffer();

  const cutout = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const hit = sampleMask(filled, maskWidth, maskHeight, box, crop.left + x, crop.top + y);
      const off = (y * cw + x) * 4;
      cutout[off] = base[off];
      cutout[off + 1] = base[off + 1];
      cutout[off + 2] = base[off + 2];
      cutout[off + 3] = hit ? 255 : 0;
    }
  }
  const png = await sharp(cutout, { raw: { width: cw, height: ch, channels: 4 } })
    .png()
    .toBuffer();
  return { png, areaFraction };
}
