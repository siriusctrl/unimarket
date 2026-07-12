import type { ProjectedDrawing, ProfileBar } from "./chart-projection";

const COLORS = {
  support: "#69b892",
  resistance: "#d47c68",
  accent: "#d7b86b",
  muted: "#8b929b",
  warning: "#d9a05b",
} as const;

const lineDash = (style: ProjectedDrawing["lineStyle"]): string | undefined => {
  if (style === "dashed") return "8 6";
  if (style === "dotted") return "2 5";
  return undefined;
};

const labelAnchor = (drawing: ProjectedDrawing) => {
  if (drawing.labelPlacement.at === "middle") {
    return drawing.points.reduce(
      (center, point) => ({ x: center.x + point.x / drawing.points.length, y: center.y + point.y / drawing.points.length }),
      { x: 0, y: 0 },
    );
  }
  if (drawing.labelPlacement.at === "end") return drawing.points.at(-1)!;
  return drawing.points[0];
};

const DrawingLabel = ({ drawing, color, text }: { drawing: ProjectedDrawing; color: string; text?: string }) => {
  if (!text) return null;
  const anchor = labelAnchor(drawing);
  return (
    <text
      x={anchor.x + drawing.labelPlacement.offsetX}
      y={anchor.y + drawing.labelPlacement.offsetY}
      fill={color}
      fontSize="11"
    >
      {text}
    </text>
  );
};

const MarkerGlyph = ({ drawing, color }: { drawing: ProjectedDrawing; color: string }) => {
  const point = drawing.points[0];
  if (drawing.shape === "diamond") {
    return <polygon points={`${point.x},${point.y - 6} ${point.x + 6},${point.y} ${point.x},${point.y + 6} ${point.x - 6},${point.y}`} fill={color} />;
  }
  if (drawing.shape === "arrowUp") {
    return <path d={`M ${point.x} ${point.y - 7} L ${point.x + 6} ${point.y + 2} H ${point.x + 2} V ${point.y + 7} H ${point.x - 2} V ${point.y + 2} H ${point.x - 6} Z`} fill={color} />;
  }
  if (drawing.shape === "arrowDown") {
    return <path d={`M ${point.x} ${point.y + 7} L ${point.x + 6} ${point.y - 2} H ${point.x + 2} V ${point.y - 7} H ${point.x - 2} V ${point.y - 2} H ${point.x - 6} Z`} fill={color} />;
  }
  return <circle cx={point.x} cy={point.y} r="5" fill={color} />;
};

export const DrawingOverlay = ({ drawings, profileBars }: { drawings: ProjectedDrawing[]; profileBars: ProfileBar[] }) => (
  <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-hidden" aria-label="Technical analysis drawings">
    <g aria-label="Approximate volume profile" data-volume-profile-bins={profileBars.length}>
      {profileBars.map((bar, index) => (
        <rect
          key={index}
          data-profile-bin={index}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill={bar.inValueArea ? "#d7b86b" : "#8b929b"}
          fillOpacity={bar.inValueArea ? 0.2 : 0.1}
        />
      ))}
    </g>
    {drawings.map((drawing) => {
      const stroke = COLORS[drawing.color];
      if (drawing.type === "channel" || drawing.type === "rectangle") {
        return (
          <g key={drawing.id} data-drawing-id={drawing.id}>
            <polygon
              points={drawing.points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill={stroke}
              fillOpacity={drawing.fillOpacity}
              stroke={stroke}
              strokeWidth={drawing.width}
              strokeDasharray={lineDash(drawing.lineStyle)}
              opacity={drawing.opacity}
            />
            <DrawingLabel drawing={drawing} color={stroke} text={drawing.label} />
          </g>
        );
      }
      if (drawing.type === "marker" || drawing.type === "text") {
        return (
          <g key={drawing.id} data-drawing-id={drawing.id}>
            {drawing.type === "marker" ? <MarkerGlyph drawing={drawing} color={stroke} /> : null}
            <DrawingLabel drawing={drawing} color={stroke} text={drawing.text ?? drawing.label} />
          </g>
        );
      }
      const [first, second] = drawing.points;
      return (
        <g key={drawing.id} data-drawing-id={drawing.id}>
          <line
            x1={first.x}
            y1={first.y}
            x2={second.x}
            y2={second.y}
            stroke={stroke}
            strokeWidth={drawing.width}
            strokeDasharray={lineDash(drawing.lineStyle)}
            opacity={drawing.opacity}
          />
          <DrawingLabel drawing={drawing} color={stroke} text={drawing.label} />
        </g>
      );
    })}
  </svg>
);
