/** Seed actual downloadable testnet goods. Never reset sold stock on redeploy. */
export async function seedCatalog(db, merchant='yours-lab') {
 const products=[
  ['weekly-review','週次ふりかえりテンプレート','できたことを振り返り、来週の一歩を決めるMarkdownテンプレート。',300,'weekly-review.md'],
  ['travel-checklist','旅の持ち物チェックリスト','出発前から帰宅まで。自分の旅に合わせて編集できるチェックリスト。',600,'travel-checklist.md'],
  ['project-kit','個人プロジェクト計画キット','課題の整理、仮説の検証、実装、振り返りまでをまとめた計画キット。',1200,'project-kit.md'],
 ];
 for(const [id,title,description,amount,file] of products)await db.query("INSERT INTO merchant_products(merchant_id,id,title,description,currency,amount_minor,stock,attributes) VALUES($1,$2,$3,$4,'JPY',$5,10000,$6) ON CONFLICT(merchant_id,id) DO NOTHING",[merchant,id,title,description,amount,JSON.stringify({download:file,testnet:true})]);
}
