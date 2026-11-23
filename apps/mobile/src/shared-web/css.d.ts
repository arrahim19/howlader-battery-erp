declare module "*.css";
declare module "*.png" {
  const source: string | { uri: string };
  export default source;
}
