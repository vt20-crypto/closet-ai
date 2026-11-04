import "server-only";

/**
 * Open-Meteo weather (free, no key), fetched server-side. Every failure
 * degrades to null so the outfit route still returns outfits without weather.
 */

export interface WeatherSummary {
  /** Celsius, as computed. The UI converts for display. */
  highC: number;
  lowC: number;
  precipChancePct: number;
  windKph: number;
  placeName?: string;
}

export async function geocodeCity(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { latitude: number; longitude: number; name: string }[];
    };
    const first = body.results?.[0];
    if (!first || !Number.isFinite(first.latitude) || !Number.isFinite(first.longitude)) return null;
    return { lat: first.latitude, lon: first.longitude, name: first.name };
  } catch {
    return null;
  }
}

const FORECAST_TTL_MS = 15 * 60 * 1000;
/** In-memory forecast cache keyed by rounded lat/lon (per server instance). */
const forecastCache = new Map<string, { at: number; data: WeatherSummary }>();

export async function getWeather(lat: number, lon: number): Promise<WeatherSummary | null> {
  return getWeatherForDate(lat, lon, null);
}

/**
 * Forecast for a calendar date (local YYYY-MM-DD) or today when null.
 * Dates outside the 16-day forecast fall back to today.
 */
export async function getWeatherForDate(
  lat: number,
  lon: number,
  dateISO: string | null,
): Promise<WeatherSummary | null> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${dateISO ?? "today"}`;
    const cached = forecastCache.get(key);
    if (cached && Date.now() - cached.at < FORECAST_TTL_MS) {
      console.log("weather cache=hit");
      return cached.data;
    }
    console.log("weather cache=miss");
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
        `&forecast_days=${dateISO ? 16 : 1}&timezone=auto`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      daily?: {
        time?: string[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_probability_max?: (number | null)[];
        wind_speed_10m_max?: (number | null)[];
      };
    };
    let index = 0;
    if (dateISO) {
      const at = (body.daily?.time ?? []).indexOf(dateISO);
      index = at >= 0 ? at : 0;
    }
    const highC = body.daily?.temperature_2m_max?.[index];
    const lowC = body.daily?.temperature_2m_min?.[index];
    if (typeof highC !== "number" || typeof lowC !== "number") return null;
    const summary: WeatherSummary = {
      highC: Math.round(highC * 10) / 10,
      lowC: Math.round(lowC * 10) / 10,
      precipChancePct: Math.round(body.daily?.precipitation_probability_max?.[index] ?? 0),
      windKph: Math.round((body.daily?.wind_speed_10m_max?.[index] ?? 0) * 10) / 10,
    };
    forecastCache.set(key, { at: Date.now(), data: summary });
    return summary;
  } catch {
    return null;
  }
}
