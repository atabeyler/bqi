import {it,expect} from 'vitest';
import {networkCanaries} from '../src/pentest/deploymentReadiness.js';
it('requires bounded explicit IPv4 and IPv6 canaries without credentials, queries or arbitrary paths',()=>{
 const values=['http://192.0.2.1:8080/bci-network-canary','http://[2001:db8::1]:8080/bci-network-canary'];expect(networkCanaries(JSON.stringify(values))).toEqual(values);
 for(const bad of [[values[0]],[values[0],'http://host.example.com/bci-network-canary'],[values[0],'http://[2001:db8::1]/admin'],[values[0],'http://user:password@[2001:db8::1]/bci-network-canary']])expect(()=>networkCanaries(JSON.stringify(bad))).toThrow();
});
