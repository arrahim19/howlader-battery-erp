declare module "*.css";
declare module "*.webp" {
  const source: string | { uri: string };
  export default source;
}
declare module "*.png" {
  const source: string | { uri: string };
  export default source;
}
