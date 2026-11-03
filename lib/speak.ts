// Thin browser-speech wrapper (Web Speech API, not a Meta model).
// Speech may only start from a user tap chain, so callers prime it inside
// the tap handler via unlockSpeech() before any async work.

export function unlockSpeech(): void {
  try {
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    // Empty utterance unlocks the gesture-gated speech chain on iOS.
    synth.speak(new SpeechSynthesisUtterance(" "));
  } catch {
    // Speech is best-effort; the visible UI always carries the message.
  }
}

export function speak(text: string): void {
  try {
    if (typeof window === "undefined" || !text) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    if (synth.paused) synth.resume();
    synth.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // Visible text remains; speech is a bonus.
  }
}

export function stopSpeech(): void {
  try {
    if (typeof window === "undefined") return;
    window.speechSynthesis.cancel();
  } catch {
    // Nothing to stop.
  }
}
