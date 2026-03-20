import { test } from '@playwright/test';

test('debug terminal theme', async ({ page }) => {
  await page.goto('/');
  
  // Wait for terminal iframe to load
  await page.waitForTimeout(3000);
  
  // Check term structure
  const result = await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const win = iframe?.contentWindow as any;
    const term = win?.term;
    
    if (!term) return { error: 'term not found' };
    
    const coreKeys = term._core ? Object.keys(term._core) : [];
    
    return {
      coreKeys: coreKeys.join(', '),
      optionsThemeBg: term.options?.theme?.background,
      viewportBg: iframe?.contentDocument?.querySelector('.xterm-viewport')?.getAttribute('style'),
    };
  });
  
  console.log('Initial state:', JSON.stringify(result, null, 2));
  
  // Try to set theme with !important
  await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const win = iframe?.contentWindow as any;
    const term = win?.term;
    const viewport = iframe?.contentDocument?.querySelector('.xterm-viewport') as HTMLElement;
    
    if (term) {
      term.options.theme = { background: '#ffffff', foreground: '#1e1e1e' };
    }
    
    if (viewport) {
      viewport.style.setProperty('background-color', '#ffffff', 'important');
    }
  });
  
  await page.waitForTimeout(1000);
  
  const result2 = await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const viewport = iframe?.contentDocument?.querySelector('.xterm-viewport') as HTMLElement;
    return {
      viewportStyle: viewport?.style?.backgroundColor,
      viewportComputed: viewport ? getComputedStyle(viewport).backgroundColor : null,
    };
  });
  
  console.log('After setting:', JSON.stringify(result2, null, 2));
  
  await page.waitForTimeout(10000);
});
