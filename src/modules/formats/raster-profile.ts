export const rasterAdapterProfile = 'raster-v1';
export const rasterDimensionLimit = 'raster_dimension_limit';

export function largeJpegRecoveryVersion(version: string | null, media: string, path: string) {
  return version?.startsWith(rasterAdapterProfile + ':') &&
    (media.toLowerCase() === 'image/jpeg' || /\.jpe?g$/iu.test(path))
    ? version + ':large-jpeg-v1' : null;
}
