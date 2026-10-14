import {evaluateScopeAuthorization} from './policyEngine.js';
import {withPentestTransport,bindRequestPolicy} from '../pentest/transport.js';
import {operatorOrigins} from '../pentest/environmentPolicy.js';
export async function withAuthorizedTransport({orgId,actorUserId,target,requestedClass},operation){
 const decision=await evaluateScopeAuthorization({orgId,actorUserId,target,requestedClass});
 if(decision.decision!=='ALLOW')throw Object.assign(new Error('active target scope unavailable'),{status:403});
 const url=new URL(/^https?:\/\//i.test(target)?target:`https://${target}`),engagement={target:url.toString(),environment:operatorOrigins('BCI_NATIVE_LAB_ORIGINS').includes(url.origin)?'LAB':'PRODUCTION'};
 bindRequestPolicy(engagement,async(value)=>{const scope=await evaluateScopeAuthorization({orgId,actorUserId,target:value,requestedClass});if(scope.decision!=='ALLOW')throw new Error('active request scope unavailable');});
 return withPentestTransport({engagement},undefined,()=>operation(decision));
}
