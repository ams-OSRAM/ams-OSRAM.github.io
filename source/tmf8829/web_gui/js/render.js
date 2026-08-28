/*****************************************************************************
 * Canvas based visualisation: pixel heat map, colour bar and histogram plot.
 *****************************************************************************/

/** Turbo-like colour map control points (t, r, g, b). */
const COLOR_STOPS = [
  [0.00, 20, 48, 115],
  [0.15, 65, 105, 225],
  [0.35, 26, 188, 156],
  [0.55, 154, 205, 50],
  [0.75, 253, 174, 51],
  [1.00, 200, 30, 30],
];

const DISTANCE_COLOR_REFERENCE_MM = 4000;
const DISTANCE_DOT_REFERENCE_MM = 1000;
const POINT_CLOUD_AXIS_LENGTH_MM = 500;

export function colorMap(t) {
  const value = Math.min(1, Math.max(0, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t1, r1, g1, b1] = COLOR_STOPS[i];
    if (value <= t1) {
      const [t0, r0, g0, b0] = COLOR_STOPS[i - 1];
      const k = (value - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * Draws a rows x columns value matrix as a heat map.
 * `values[y][x]` may contain null for invalid pixels.
 */
export function drawHeatMap(canvas, values, { min, max, highlight = null }) {
  const context = canvas.getContext('2d');
  const rows = values.length;
  const columns = rows ? values[0].length : 0;
  if (!rows || !columns) return;

  const image = context.createImageData(columns, rows);
  const span = (max - min) || 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const index = (y * columns + x) * 4;
      const value = values[y][x];
      if (value === null || value === undefined || Number.isNaN(value)) {
        image.data.set([52, 57, 62, 255], index);
      } else {
        const [r, g, b] = colorMap((value - min) / span);
        image.data.set([r, g, b, 255], index);
      }
    }
  }

  const buffer = document.createElement('canvas');
  buffer.width = columns;
  buffer.height = rows;
  buffer.getContext('2d').putImageData(image, 0, 0);

  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(buffer, 0, 0, canvas.width, canvas.height);

  if (highlight) {
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.strokeRect(highlight.x * cellWidth, highlight.y * cellHeight, cellWidth, cellHeight);
  }
}

export function drawColorBar(canvas, min, max, unit) {
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  const gradientHeight = height - 18;
  for (let x = 0; x < width; x++) {
    const [r, g, b] = colorMap(x / (width - 1));
    context.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    context.fillRect(x, 0, 1, gradientHeight);
  }
  context.fillStyle = '#cfd4dc';
  context.font = '11px system-ui, sans-serif';
  context.textBaseline = 'top';
  context.textAlign = 'left';
  context.fillText(`${min.toFixed(0)} ${unit}`, 2, gradientHeight + 3);
  context.textAlign = 'right';
  context.fillText(`${max.toFixed(0)} ${unit}`, width - 2, gradientHeight + 3);
}

/** Draws one or more histogram series as line plots. */
export function drawHistogram(canvas, series, { title = '', logScale = false, max = null } = {}) {
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  const padding = { left: 46, right: 8, top: 18, bottom: 22 };
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#454b52';
  context.fillRect(0, 0, width, height);

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const valid = series.filter((s) => s.data && s.data.length);
  let maxValue = 1;
  let bins = 1;
  for (const item of valid) {
    bins = Math.max(bins, item.data.length);
    for (const value of item.data) if (value > maxValue) maxValue = value;
  }
  if (max !== null && Number.isFinite(max) && max > 0) maxValue = max;

  const logMax = Math.log10(1 + maxValue);
  const normalise = (value) => {
    const clamped = Math.max(0, Math.min(maxValue, value));
    return logScale ? Math.log10(1 + clamped) / logMax : clamped / maxValue;
  };
  const axisValue = (fraction) => (logScale ? 10 ** (fraction * logMax) - 1 : maxValue * fraction);

  // Grid and axes.
  context.strokeStyle = '#899199';
  context.lineWidth = 1;
  context.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotHeight * i) / 4;
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
  }
  context.stroke();

  context.fillStyle = '#eef0f2';
  context.font = '11px system-ui, sans-serif';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotHeight * i) / 4;
    context.fillText(Math.round(axisValue((4 - i) / 4)).toString(), padding.left - 5, y);
  }
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.fillText(title, padding.left, 2);
  context.textAlign = 'center';
  context.fillText('bin', padding.left + plotWidth / 2, height - 14);

  if (!valid.length) {
    context.textAlign = 'center';
    context.fillStyle = '#d7dce0';
    context.fillText('no histogram data', width / 2, padding.top + plotHeight / 2);
    return;
  }

  for (const item of valid) {
    context.strokeStyle = item.color;
    context.lineWidth = 1.5;
    context.beginPath();
    for (let i = 0; i < item.data.length; i++) {
      const x = padding.left + (plotWidth * i) / Math.max(1, bins - 1);
      const y = padding.top + plotHeight - plotHeight * normalise(item.data[i]);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  // Legend.
  let legendX = padding.left + 4;
  context.textAlign = 'left';
  for (const item of valid) {
    if (!item.label) continue;
    context.fillStyle = item.color;
    context.fillRect(legendX, padding.top + 4, 8, 8);
    context.fillStyle = '#f1f3f5';
    context.fillText(item.label, legendX + 12, padding.top + 3);
    legendX += 20 + context.measureText(item.label).width;
  }
}

/** Converts one depth pixel into a 3D Cartesian coordinate. */
export function getPixelXYZ(row, col, distance, itsCols, itsRows, fovCorrection = null) {
  const spanX = (itsCols * 3.0) / 4.0;
  const spanY = itsRows;
  let x;
  let y;

  if (fovCorrection !== null && fovCorrection !== undefined) {
    const fovCorrX = fovCorrection & 0b11;
    const fovCorrY = (fovCorrection >> 2) & 0b11;
    x = (col - itsCols / 2.0 + 0.5) / spanX - (fovCorrX - 1.5) / 2.5 / 16;
    y = (row - itsRows / 2.0 + 0.5) / spanY - (fovCorrY - 1.5) / 2.5 / 16;
  } else {
    x = (col - itsCols / 2.0 + 0.5) / spanX;
    y = (row - itsRows / 2.0 + 0.5) / spanY;
  }

  const depth = distance / Math.sqrt(1 + x * x + y * y);
  return {
    x: Math.round(depth * x),
    y: Math.round(depth * y),
    z: Math.round(depth),
  };
}

/** Draws a perspective point cloud with simple yaw/pitch camera controls. */
export function drawPointCloud(canvas, points, {
  yaw = 0,
  pitch = -0.45,
  zoom = 1,
  selectedIndex = -1,
  referencePoints = null,
  pointCountForSizing = null,
  maxDistanceForColor = DISTANCE_COLOR_REFERENCE_MM,
  scaleReferenceDistance = DISTANCE_COLOR_REFERENCE_MM,
} = {}) {
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#454b52');
  gradient.addColorStop(1, '#2c3136');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  if (!points.length) {
    context.fillStyle = '#eef0f2';
    context.font = '13px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('No distance points available yet', width / 2, height / 2);
    return;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  const scalePoints = (referencePoints && referencePoints.length) ? referencePoints : points;
  const nominalPointCount = Math.max(1, pointCountForSizing ?? scalePoints.length);
  // 16x16 (256 points) is the visual baseline. Higher resolution => smaller dots.
  const resolutionDotScale = Math.max(0.48, Math.min(2.2, Math.sqrt(256 / nominalPointCount)));
  let maxRadius = 1;
  for (const point of scalePoints) {
    const radiusFromOrigin = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
    maxRadius = Math.max(maxRadius, radiusFromOrigin);
  }

  const sceneExtent = Math.max(1, Number(scaleReferenceDistance) || DISTANCE_COLOR_REFERENCE_MM);
  const cameraDistance = sceneExtent * 3.0;
  const scale = (Math.min(width, height) / (sceneExtent * 2.8)) * zoom;
  const transformed = [];

  for (let index = 0; index < points.length; index++) {
    const point = points[index];

    const x1 = point.x * cosYaw + point.z * sinYaw;
    const z1 = -point.x * sinYaw + point.z * cosYaw;
    // Invert sensor Y so positive values are rendered downward in scene space.
    const yInverted = -point.y;
    const y2 = yInverted * cosPitch - z1 * sinPitch;
    const z2 = point.y * sinPitch + z1 * cosPitch;

    const perspective = cameraDistance / (cameraDistance + z2);
    const screenX = centerX + x1 * scale * perspective;
    const screenY = centerY - y2 * scale * perspective;
    const radiusFromOrigin = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
    const radialScale = radiusFromOrigin / maxRadius;
    const distanceScale = Math.max(0.35, Math.min(1.5, (point.distance ?? 0) / DISTANCE_DOT_REFERENCE_MM));
    const radius = (1.0 + radialScale * 3.0) * distanceScale * perspective * resolutionDotScale * zoom * 0.3;

    transformed.push({
      index,
      z: z2,
      screenX,
      screenY,
      radius: Math.max(0.55, radius),
      distance: point.distance,
    });
  }

  transformed.sort((a, b) => a.z - b.z);

  for (const point of transformed) {
    const colorScaleMax = Math.max(1, Number(maxDistanceForColor) || DISTANCE_COLOR_REFERENCE_MM);
    const distanceFraction = Math.min(1, point.distance / colorScaleMax);
    const [r, g, b] = colorMap(distanceFraction);
    context.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.9)`;
    context.beginPath();
    context.arc(point.screenX, point.screenY, point.radius, 0, Math.PI * 2);
    context.fill();

    if (point.index === selectedIndex) {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 1.25;
      context.beginPath();
      context.arc(point.screenX, point.screenY, point.radius + 2.4, 0, Math.PI * 2);
      context.stroke();
    }
  }

  const projectAxis = (x, y, z) => {
    const x1 = x * cosYaw + z * sinYaw;
    const z1 = -x * sinYaw + z * cosYaw;
    const yInverted = -y;
    const y2 = yInverted * cosPitch - z1 * sinPitch;
    const z2 = y * sinPitch + z1 * cosPitch;
    const perspective = cameraDistance / (cameraDistance + z2);
    return {
      x: centerX + x1 * scale * perspective,
      y: centerY - y2 * scale * perspective,
    };
  };
  const drawAxis = ({ x, y }, color, label) => {
    const angle = Math.atan2(y - centerY, x - centerX);
    const headLength = 8;

    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(x, y);
    context.stroke();

    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - Math.cos(angle - 0.45) * headLength, y - Math.sin(angle - 0.45) * headLength);
    context.lineTo(x - Math.cos(angle + 0.45) * headLength, y - Math.sin(angle + 0.45) * headLength);
    context.closePath();
    context.fill();

    context.font = '11px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + Math.cos(angle) * 9, y + Math.sin(angle) * 9);
  };

  drawAxis(projectAxis(POINT_CLOUD_AXIS_LENGTH_MM, 0, 0), '#ff2b2b', 'X');
  drawAxis(projectAxis(0, -POINT_CLOUD_AXIS_LENGTH_MM, 0), '#25ff4a', 'Y');
  drawAxis(projectAxis(0, 0, POINT_CLOUD_AXIS_LENGTH_MM), '#1c3dff', 'Z');
}
