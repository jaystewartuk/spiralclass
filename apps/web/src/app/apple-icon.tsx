import { ImageResponse } from "next/og";
import { MARK_SMALL, palette } from "@spiralclass/shared";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: palette.primary,
        borderRadius: 36,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <path
          d={MARK_SMALL.full}
          stroke={palette.background}
          strokeWidth={MARK_SMALL.strokeWidth}
          strokeLinecap="round"
          fill="none"
          transform="translate(10 10) scale(0.9)"
        />
      </svg>
    </div>,
    { ...size },
  );
}
