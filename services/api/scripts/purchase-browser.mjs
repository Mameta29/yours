import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

/** Real paid order from payment-integration; no mocked HTTP or catalog. */
export async function verifyPurchaseBrowser({origin,cookie,orderId}){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  const at=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,at),value:cookie.slice(at+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/orders/'+orderId);
  await expect(page.getByRole('dialog')).toContainText('yours integration item');
  await expect(page.getByRole('dialog')).toContainText('支払済み');
  await page.screenshot({path:'.local/console-order.png'});
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'購入品をダウンロード'}).click();
  const file=await downloaded;
  assert.equal(await file.failure(),null);assert.match(await readFile(await file.path(),'utf8'),/週次ふりかえりテンプレート/);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.local/console-order-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
}
