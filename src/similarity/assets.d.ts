// Metro ships these as file assets (see metro.config.js); importing or
// requiring one yields the numeric asset id that expo-asset resolves.
declare module '*.pte' {
  const assetId: number;
  export default assetId;
}

declare module '*.tok' {
  const assetId: number;
  export default assetId;
}
