package com.boldas.bqi;

import android.os.Bundle;
import com.boldas.bqi.localllm.LocalLLMPlugin;
import com.boldas.bqi.passkey.PasskeyPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Manual registration of an in-app-module Capacitor plugin (as
        // opposed to every other plugin in this project, which ships under
        // node_modules and is auto-registered via the generated
        // capacitor.settings.gradle/capacitor.build.gradle -- see those
        // files' "DO NOT EDIT" headers). This project had no prior
        // in-app-module plugin before LocalLLMPlugin, which established the
        // pattern: Capacitor requires registerPlugin(...) to run before
        // super.onCreate() (which is where the Bridge itself gets built and
        // starts loading the WebView), per Capacitor's documented
        // local-plugin registration API.
        registerPlugin(LocalLLMPlugin.class);
        registerPlugin(PasskeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
