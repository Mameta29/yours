import {z} from 'zod';
export const configSchema=z.object({
 NODE_ENV:z.enum(['development','test','production']).default('development'),
 DATABASE_URL:z.string().min(1),PUBLIC_ORIGIN:z.string().url().default('http://localhost:8080'),
 PORT:z.coerce.number().int().min(1).max(65535).default(8080),
 CHAIN_ID:z.coerce.number().int().default(80002),
 RPC_URL:z.string().url().default('https://polygon-amoy-bor-rpc.publicnode.com'),
 MERCHANT_ID:z.string().default('yours-lab'),MERCHANT_NAME:z.string().default('yours Market'),
 MERCHANT_PAY_TO:z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
 JPYC_ADDRESS:z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
 GATE_ADDRESS:z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
 AGENT_ADDRESS:z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
 UCP_SIGNING_KEY:z.string().optional(),
 LOCAL_KEY_DIR:z.string().default('.local/keys'),
 MANDATES_URL:z.string().url().optional(),AGENT_URL:z.string().url().optional(),
 TRUSTED_PROFILE_ORIGINS:z.string().default(''),
});
export type Config=z.infer<typeof configSchema>;
export function readConfig(env:NodeJS.ProcessEnv=process.env):Config{
 const config=configSchema.parse(env);
 if(config.CHAIN_ID!==80002&&config.NODE_ENV!=='test'&&config.NODE_ENV!=='development')throw new Error('Only Polygon Amoy is enabled for this deployment');
 if(config.NODE_ENV==='production'&&(!config.UCP_SIGNING_KEY||!config.PUBLIC_ORIGIN.startsWith('https://')))throw new Error('Production requires KMS and HTTPS');
 return config;
}
