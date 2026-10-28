// Runs before the renderer and styles, using the saved preference supplied by preload.
const initialTheme = window.modatro?.initialTheme;
document.documentElement.dataset.theme =
  initialTheme === 'light' || initialTheme === 'balatro'
    ? initialTheme
    : initialTheme === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'light'
      : 'dark';

if (initialTheme === 'balatro') {
  const font = document.createElement('link');
  font.rel = 'preload';
  font.as = 'font';
  font.type = 'font/ttf';
  font.href = new URL('./fonts/pixelify-sans/PixelifySans.ttf', document.baseURI).href;
  font.crossOrigin = 'anonymous';
  document.head.append(font);
}
