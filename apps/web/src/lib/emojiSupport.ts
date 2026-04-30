let cached: boolean | undefined;

export function supportsEmojiFlag(): boolean {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return (cached = false);

  const size = 16;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return (cached = false);

  ctx.textBaseline = "top";
  ctx.font = `${size}px sans-serif`;
  ctx.fillText("🇨🇭", 0, 0);

  const data = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a > 0 && (r !== g || g !== b)) return (cached = true);
  }
  return (cached = false);
}
