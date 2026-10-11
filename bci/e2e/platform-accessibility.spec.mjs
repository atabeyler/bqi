import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const routes=['/','/assets','/scans','/findings','/reports','/engines','/quantum','/decision','/controlled-proof','/pentest'];
for(const lang of ['en','tr','fr','de','ar']) for(const route of routes) test(`platform ${lang} ${route} accessibility`,async({page})=> {
  const session=await(await page.request.get('http://127.0.0.1:8087/lab/session')).json();
  await page.addInitScript(({token,lang})=>{localStorage.setItem('bci_token',token);localStorage.setItem('bci_ui_lang',lang);},{token:session.token,lang});
  await page.goto(route); await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang',lang);
  await expect(page.locator('html')).toHaveAttribute('dir',lang === 'ar' ? 'rtl' : 'ltr');
  await expect(page.locator('main h2').first()).toBeVisible();
  if(route === '/controlled-proof') await expect(page.locator('main h2')).toHaveText({en:'CONTROLLED PROOF OF IMPACT',tr:'KONTROLLÜ ETKİ DOĞRULAMASI',fr:'PREUVE CONTRÔLÉE D’IMPACT',de:'KONTROLLIERTER AUSWIRKUNGSNACHWEIS',ar:'إثبات الأثر الخاضع للتحكم'}[lang]);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(result.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>n.target)}))).toEqual([]);
});
for(const lang of ['en','tr','fr','de','ar']) test(`login ${lang} accessibility`,async({page})=> {
  await page.addInitScript((lang)=>{localStorage.removeItem('bci_token');localStorage.setItem('bci_ui_lang',lang);},lang);
  await page.goto('/login');await expect(page.getByRole('button',{name:/./}).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang',lang);
  await expect(page.locator('html')).toHaveAttribute('dir',lang === 'ar' ? 'rtl' : 'ltr');
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);
});
