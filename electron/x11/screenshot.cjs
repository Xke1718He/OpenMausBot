const { deflateSync } = require("node:zlib");

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function component(mask) {
  if (!mask) throw new Error("Screenshot has an unsupported color mask");
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const maximum = mask >>> shift;
  if ((maximum & (maximum + 1)) !== 0) throw new Error("Screenshot has a noncontiguous color mask");
  return pixel => Math.round(((pixel & mask) >>> shift) * 255 / maximum);
}

function xwdToPng(bytes) {
  if (bytes.length < 100) throw new Error("Screenshot is truncated");
  const fields = Array.from({ length: 25 }, (_, index) => bytes.readUInt32BE(index * 4));
  const [headerSize, version, format, depth, width, height, xOffset, byteOrder, , , , bits, stride, visual, red, green, blue, , , colors] = fields;
  const offset = headerSize + colors * 12;
  if (version !== 7 || format !== 2 || visual !== 4 || ![24, 32].includes(depth) || ![24, 32].includes(bits) ||
      xOffset !== 0 || ![0, 1].includes(byteOrder) || headerSize < 100 || !width || !height || width > 8192 || height > 8192 ||
      width * height > 16_777_216 || stride < width * bits / 8 || offset + stride * height > bytes.length ||
      (red & green) || (red & blue) || (green & blue)) throw new Error("Screenshot format or dimensions are unsupported");
  const channels = [component(red), component(green), component(blue)];
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const start = offset + y * stride + x * bits / 8;
    const pixel = byteOrder === 0 ? bytes.readUIntLE(start, bits / 8) : bytes.readUIntBE(start, bits / 8);
    const target = y * (width * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 3; channel++) rows[target + channel] = channels[channel](pixel);
    rows[target + 3] = 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
  if (png.length > 6 * 1024 * 1024) throw new Error("Screenshot is too large; resize the window and try again");
  return { png, width, height };
}

module.exports = { xwdToPng };
