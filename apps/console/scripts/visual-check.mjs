import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.YOURS_PREVIEW_ORIGIN??'http://localhost:8080');await page.getByText('個人プロジェクト計画キット',{exact:true}).waitFor();
 await page.screenshot({path:'.local/console-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'ウォレットを接続',exact:true}).first().click();await page.getByRole('dialog').waitFor();
 await page.screenshot({path:'.local/console-wallet.png'});await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.local/console-mobile.png',fullPage:true});
 console.log(JSON.stringify({errors,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),title:await page.title(),dialogClosed:await page.getByRole('dialog').count()===0}));
}finally{await browser.close();}
