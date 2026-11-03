"use client";

import { useEffect, useState } from "react";

import { Tape } from "./sticker";

const CITY_KEY = "closet-ai-city";

function displayTemp(celsius: number): string {
  if (typeof navigator !== "undefined" && navigator.language === "en-US") {
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(celsius)}°C`;
}

async function fetchHighC(lat: number, lon: number): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max&forecast_days=1&timezone=auto`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { daily?: { temperature_2m_max?: (number | null)[] } };
    const high = body.daily?.temperature_2m_max?.[0];
    return typeof high === "number" ? high : null;
  } catch {
    return null;
  }
}

async function geocodeCity(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: { latitude: number; longitude: number }[] };
    const first = body.results?.[0];
    if (!first || !Number.isFinite(first.latitude) || !Number.isFinite(first.longitude)) return null;
    return { lat: first.latitude, lon: first.longitude };
  } catch {
    return null;
  }
}

/** Today's weather as a tape sticker. Renders nothing until it loads (or on any failure). */
export default function HomeWeather() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const day = new Date().toLocaleDateString(undefined, { weekday: "short" });
      let coords: { lat: number; lon: number } | null = null;
      try {
        const saved = window.localStorage.getItem(CITY_KEY);
        if (saved) coords = await geocodeCity(saved);
      } catch {
        coords = null;
      }
      if (!coords && "geolocation" in navigator) {
        try {
          const pos: GeolocationPosition = await new Promise((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: false,
              timeout: 10000,
              maximumAge: 600000,
            }),
          );
          coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        } catch {
          coords = null;
        }
      }
      if (!coords || cancelled) return;
      const high = await fetchHighC(coords.lat, coords.lon);
      if (high === null || cancelled) return;
      setLabel(`${day} · ${displayTemp(high)}`);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!label) return null;
  return <Tape label={label} seedId="home-weather" />;
}
