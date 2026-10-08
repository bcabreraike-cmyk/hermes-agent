import { authedFetch } from "@/lib/api";

/** Minimal browser voice I/O over the existing gateway audio endpoints. */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("audio read failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("audio read failed"));
    };
    reader.readAsDataURL(blob);
  });
}

export async function transcribeRecording(
  blob: Blob,
  profile = "",
): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  const mimeType = blob.type || "audio/webm";
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const res = await authedFetch(`/api/audio/transcribe${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data_url: dataUrl, mime_type: mimeType }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { transcript?: unknown };
  return typeof body.transcript === "string" ? body.transcript : "";
}

export async function speakText(text: string, profile = ""): Promise<void> {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const res = await authedFetch(`/api/audio/speak${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data_url?: unknown };
  if (typeof body.data_url !== "string" || !body.data_url) {
    throw new Error("TTS did not return audio");
  }
  const audio = new Audio(body.data_url);
  await audio.play();
}
