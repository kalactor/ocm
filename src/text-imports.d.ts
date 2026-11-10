declare module "*.bash" {
  const content: string;
  export default content;
}

declare module "_ocm" {
  const content: string;
  export default content;
}

declare module "../completions/_ocm" {
  const content: string;
  export default content;
}

declare module "*completions/_ocm" {
  const content: string;
  export default content;
}
