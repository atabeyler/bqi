import {query} from '../db/client.js';
export function persistentAuthenticationSafety(orgId,accountId,maximum) {
 return {
  async before(){const result=await query(`INSERT INTO pentest_authentication_budgets(org_id,account_id,attempts,window_ends_at) VALUES($1,$2,1,now()+interval '5 minutes')
   ON CONFLICT(org_id,account_id) DO UPDATE SET attempts=CASE WHEN pentest_authentication_budgets.window_ends_at<=now() THEN 1 ELSE pentest_authentication_budgets.attempts+1 END,
   failures=CASE WHEN pentest_authentication_budgets.window_ends_at<=now() THEN 0 ELSE pentest_authentication_budgets.failures END,
   window_ends_at=CASE WHEN pentest_authentication_budgets.window_ends_at<=now() THEN now()+interval '5 minutes' ELSE pentest_authentication_budgets.window_ends_at END
   WHERE (pentest_authentication_budgets.blocked_until IS NULL OR pentest_authentication_budgets.blocked_until<=now()) AND (pentest_authentication_budgets.window_ends_at<=now() OR pentest_authentication_budgets.attempts<$3) RETURNING attempts`,[orgId,accountId,maximum]);
   if(!result.rowCount)throw Object.assign(new Error('persistent account authentication budget blocked'),{code:'AUTHENTICATION_SAFETY_STOP'});
  },
  async after(response){if([401,403,423,429].includes(response.status))await query("UPDATE pentest_authentication_budgets SET failures=failures+1,blocked_until=CASE WHEN $3 OR failures+1>=2 THEN now()+interval '15 minutes' ELSE blocked_until END WHERE org_id=$1 AND account_id=$2",[orgId,accountId,[423,429].includes(response.status)]);}
 };
}
