import {it,expect} from 'vitest';
import {recoveryEnvironment} from '../src/services/databaseRecovery.js';
it('passes explicit libpq host, port, database and escaped credentials without URI-in-PGDATABASE ambiguity',()=>{
 const env=recoveryEnvironment('postgresql://bci:p%40ss@127.0.0.1:55434/isolated?sslmode=verify-full&connect_timeout=7');
 expect(env).toEqual(expect.objectContaining({PGHOST:'127.0.0.1',PGPORT:'55434',PGDATABASE:'isolated',PGUSER:'bci',PGPASSWORD:'p@ss',PGSSLMODE:'verify-full',PGCONNECT_TIMEOUT:'7'}));
 expect(()=>recoveryEnvironment('postgres://bci@localhost/db?unsupported_option=true')).toThrow();
 expect(()=>recoveryEnvironment('https://localhost/db')).toThrow();
});
