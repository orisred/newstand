import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Portal.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.profile.addresses.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
