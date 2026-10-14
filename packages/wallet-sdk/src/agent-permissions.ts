import type {Address,Hex} from 'viem';
export const agentPermissionTypes={
 AgentPermission:[
  {name:'account',type:'address'},{name:'policyId',type:'bytes32'},{name:'connectionId',type:'bytes32'},
  {name:'revision',type:'uint64'},{name:'agent',type:'address'},{name:'validUntil',type:'uint64'},
  {name:'perOrder',type:'uint256'},{name:'perPeriod',type:'uint256'},{name:'merchantsHash',type:'bytes32'},
  {name:'nonce',type:'uint64'},{name:'deadline',type:'uint64'},
 ],
 RevokeAgent:[{name:'account',type:'address'},{name:'connectionId',type:'bytes32'},{name:'nonce',type:'uint64'},{name:'deadline',type:'uint64'}],
} as const;
export interface AgentPermission {
 account:Address;policyId:Hex;connectionId:Hex;revision:bigint;agent:Address;validUntil:bigint;
 perOrder:bigint;perPeriod:bigint;merchantsHash:Hex;
}
export function agentPermissionDomain(chainId:number,registry:Address){
 return {name:'yours Agent Permissions',version:'1',chainId,verifyingContract:registry} as const;
}
export const taskConsentTypes={
 TaskConsent:[{name:'account',type:'address'},{name:'connectionId',type:'bytes32'},{name:'taskHash',type:'bytes32'},{name:'nonce',type:'bytes32'},{name:'validUntil',type:'uint64'}],
 OrderConsent:[{name:'account',type:'address'},{name:'intentHash',type:'bytes32'},{name:'riskDigest',type:'bytes32'},{name:'overrideMask',type:'uint32'},{name:'nonce',type:'bytes32'},{name:'validUntil',type:'uint64'}],
} as const;
export const consentDomain=(chainId:number,gate:Address)=>({name:'yours Consent',version:'1',chainId,verifyingContract:gate} as const);
