const CALLBACK_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow'
};

/**
 * Keep Pages' clean-URL response and callback document intact, while applying
 * the same security policy to both the requested .html URL and its final URL.
 */
export async function onGoogleAuthCallback(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CALLBACK_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
