import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',workers:1,timeout:90000,
  reporter:[['list'],['json',{outputFile:'evidence/pentest-completion/browser-results.json'}]],
  use:{baseURL:'http://127.0.0.1:4174',headless:true,trace:'off',screenshot:'only-on-failure'},
  webServer:{command:'node scripts/pentest-ui-lab.mjs',url:'http://127.0.0.1:4174',timeout:60000,reuseExistingServer:false,
    env:{BCI_ENABLE_E2E_LAB:'1'}},
});
