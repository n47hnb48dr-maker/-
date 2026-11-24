package nl.kwast.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private static final int PICK = 10;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(web);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        // The UI is served from https://appassets.androidplatform.net; a debug build may call an
        // http:// pilot server on the LAN, which WebView would otherwise block as mixed content.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            WebView.setWebContentsDebuggingEnabled(true);
        }
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !"appassets.androidplatform.net".equals(request.getUrl().getHost());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Newer WebView versions may ask before the page reaches a server on the local network.
            // Only the app's own bundled page is trusted; camera, microphone and DRM are never granted.
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (!"appassets.androidplatform.net".equals(request.getOrigin().getHost())) { request.deny(); return; }
                java.util.List<String> allowed = new java.util.ArrayList<>();
                for (String r : request.getResources()) {
                    if (!r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                            && !r.equals(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID) && !r.equals(PermissionRequest.RESOURCE_MIDI_SYSEX)) allowed.add(r);
                }
                if (allowed.isEmpty()) request.deny(); else request.grant(allowed.toArray(new String[0]));
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams options) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try { startActivityForResult(options.createIntent(), PICK); }
                catch (android.content.ActivityNotFoundException e) { callback.onReceiveValue(null); pendingFiles = null; }
                return true;
            }
        });
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
        }
    }
}
