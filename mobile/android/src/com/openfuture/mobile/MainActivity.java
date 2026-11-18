package com.openfuture.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * Thin Android shell around the OpenFuture remote UI.
 *
 * The phone app is deliberately dumb: the real UI is served by the desktop
 * app at http://<lan-ip>:8787, so updating the desktop updates the app.
 * This activity only remembers the server address and hosts a WebView.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "openfuture";
    private static final String DEFAULT_PORT = "8787";

    private FrameLayout root;
    private WebView web;
    private TextView gear;
    private View loading;
    private TextView loadingText;
    private View errorBox;
    private TextView errorText;
    private String currentUrl = "";
    private String lastError = "";
    private String lastConsole = "";
    private String pendingQr = "";
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f1115"));
        setContentView(root);

        pendingQr = qrScript(getIntent());

        String saved = prefs().getString("server", "");
        if (saved == null || saved.isEmpty()) {
            promptServer(true);
        } else {
            loadServer(saved);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) return;
        setIntent(intent);
        String script = qrScript(intent);
        if (script.isEmpty()) return;
        pendingQr = script;
        flushQr();
    }

    /** Build the JS call that hands a scanned QR ticket to the page ("" when not a QR link). */
    private String qrScript(Intent intent) {
        if (intent == null || intent.getData() == null) return "";
        Uri data = intent.getData();
        if (!"openfuture".equals(data.getScheme()) || !"qr".equals(data.getHost())) return "";
        String ticket = data.getQueryParameter("t");
        if (ticket == null || ticket.trim().isEmpty()) return "";
        String base = data.getQueryParameter("b");
        try {
            return "window.__ofQr(" + JSONObject.quote(ticket.trim()) + ","
                    + JSONObject.quote(base == null ? "" : base) + ");";
        } catch (Exception ignored) {
            return "";
        }
    }

    private void flushQr() {
        if (pendingQr == null || pendingQr.isEmpty() || web == null || !pageReady) return;
        final String script = pendingQr;
        pendingQr = "";
        web.post(() -> web.evaluateJavascript(script, null));
    }

    /** Build the WebView lazily so the first screen is just the address dialog. */
    private void loadServer(String base) {
        if (web == null) {
            web = buildWebView();
            root.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            gear = new TextView(this);
            gear.setText("⚙");
            gear.setTextSize(20);
            gear.setTextColor(Color.parseColor("#e8eaf0"));
            gear.setGravity(Gravity.CENTER);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.parseColor("#99181c24"));
            bg.setCornerRadius(28f);
            gear.setBackground(bg);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(44), dp(44));
            lp.gravity = Gravity.TOP | Gravity.END;
            lp.topMargin = dp(12);
            lp.rightMargin = dp(12);
            gear.setOnClickListener(v -> promptServer(false));
            gear.setOnLongClickListener(v -> {
                showDiagnostics();
                return true;
            });
            root.addView(gear, lp);

            buildLoading();
            buildErrorBox();
        }
        currentUrl = base;
        pageReady = false;
        hideError();
        showLoading("正在连接 " + base);
        web.loadUrl(base);
    }

    private WebView buildWebView() {
        WebView view = new WebView(this);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " OpenFutureApp/1.3");

        view.setBackgroundColor(Color.parseColor("#0f1115"));
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                pageReady = true;
                hideLoading();
                flushQr();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError("打不开这个地址：\n" + request.getUrl() + "\n\n" + error.getDescription()
                            + "（" + error.getErrorCode() + "）");
                }
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                if (request != null && request.isForMainFrame()) {
                    showError("电脑端返回 HTTP " + response.getStatusCode() + "\n" + request.getUrl());
                }
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                lastConsole = message.messageLevel() + ": " + message.message()
                        + " (" + message.sourceId() + ":" + message.lineNumber() + ")";
                return true;
            }
        });
        return view;
    }

    private void buildLoading() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0f1115"));
        box.setPadding(dp(28), dp(28), dp(28), dp(28));

        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleLarge);
        bar.setIndeterminate(true);
        box.addView(bar);

        loadingText = new TextView(this);
        loadingText.setTextColor(Color.parseColor("#9aa3b2"));
        loadingText.setTextSize(13);
        loadingText.setGravity(Gravity.CENTER);
        loadingText.setPadding(0, dp(14), 0, 0);
        box.addView(loadingText);

        loading = box;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(loading, lp);
    }

    private void buildErrorBox() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0f1115"));
        box.setPadding(dp(24), dp(24), dp(24), dp(24));

        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#ffb4ac"));
        errorText.setTextSize(13);
        errorText.setLineSpacing(dp(2), 1f);
        errorText.setGravity(Gravity.CENTER);
        box.addView(errorText);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(0, dp(18), 0, 0);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> {
            hideError();
            if (!TextUtils.isEmpty(currentUrl)) {
                showLoading("正在重试 " + currentUrl);
                web.loadUrl(currentUrl);
            }
        });
        actions.addView(retry);

        Button browse = new Button(this);
        browse.setText("用浏览器打开");
        browse.setOnClickListener(v -> {
            if (!TextUtils.isEmpty(currentUrl)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(currentUrl)));
                } catch (Exception ignored) {
                }
            }
        });
        actions.addView(browse);

        Button change = new Button(this);
        change.setText("改地址");
        change.setOnClickListener(v -> promptServer(false));
        actions.addView(change);

        box.addView(actions);

        errorBox = box;
        errorBox.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(errorBox, lp);
    }

    private void showLoading(String message) {
        if (loading == null) return;
        loadingText.setText(message);
        loading.setVisibility(View.VISIBLE);
        loading.bringToFront();
    }

    private void hideLoading() {
        if (loading != null) loading.setVisibility(View.GONE);
    }

    private void showError(String message) {
        lastError = message;
        hideLoading();
        if (errorBox == null) return;
        errorText.setText(message);
        errorBox.setVisibility(View.VISIBLE);
        errorBox.bringToFront();
        if (gear != null) gear.bringToFront();
    }

    private void hideError() {
        if (errorBox != null) errorBox.setVisibility(View.GONE);
    }

    /** Long-press the gear: what the WebView is, where it was pointed, what broke. */
    private void showDiagnostics() {
        StringBuilder info = new StringBuilder();
        info.append("地址：").append(currentUrl).append("\n");
        if (Build.VERSION.SDK_INT >= 26) {
            android.content.pm.PackageInfo pkg = WebView.getCurrentWebViewPackage();
            info.append("WebView：").append(pkg == null ? "未知" : pkg.packageName + " " + pkg.versionName).append("\n");
        } else {
            info.append("WebView：系统内置（Android ").append(Build.VERSION.RELEASE).append("）\n");
        }
        info.append("设备：").append(Build.MANUFACTURER).append(" ").append(Build.MODEL)
                .append(" / Android ").append(Build.VERSION.RELEASE).append("\n");
        if (!TextUtils.isEmpty(lastError)) info.append("\n最近错误：\n").append(lastError).append("\n");
        if (!TextUtils.isEmpty(lastConsole)) info.append("\n控制台：\n").append(lastConsole).append("\n");

        new AlertDialog.Builder(this)
                .setTitle("连接诊断")
                .setMessage(info.toString())
                .setPositiveButton("复制", (d, w) -> {
                    android.content.ClipboardManager cm =
                            (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("OpenFuture", info.toString()));
                    Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    /** Ask for (and persist) http://host:port. */
    private void promptServer(boolean firstRun) {
        String current = prefs().getString("server", "http://192.168.1.10:" + DEFAULT_PORT);
        current = current.replaceFirst("^https?://", "").replaceFirst("/+$", "");

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("192.168.1.10:" + DEFAULT_PORT);
        input.setText(current);
        input.setPadding(dp(20), dp(12), dp(20), dp(12));

        TextView help = new TextView(this);
        help.setText("输入电脑上「设置 → 手机访问」显示的地址（电脑和手机连同一个 Wi-Fi）。\n"
                + "例如 192.168.31.32:" + DEFAULT_PORT);
        help.setTextSize(13);
        help.setTextColor(Color.parseColor("#9aa3b2"));
        help.setPadding(dp(20), dp(12), dp(20), 0);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.addView(help);
        box.addView(input);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("连接电脑")
                .setView(box)
                .setCancelable(!firstRun)
                .setPositiveButton("连接", null)
                .setNegativeButton("退出", (d, w) -> finish())
                .create();

        dialog.setOnShowListener(d -> {
            Button ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            ok.setOnClickListener(v -> {
                String raw = input.getText().toString().trim();
                String base = normalize(raw);
                if (base == null) {
                    input.setError("地址格式不对，应类似 192.168.31.32:" + DEFAULT_PORT);
                    return;
                }
                prefs().edit().putString("server", base).apply();
                dialog.dismiss();
                loadServer(base);
            });
        });
        dialog.show();
    }

    /** Accept "ip", "ip:port", "http://ip:port/", and default the port to 8787. */
    private String normalize(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        String value = raw.trim().replaceFirst("^https?://", "").replaceFirst("/.*$", "");
        if (value.isEmpty() || value.contains(" ")) return null;
        if (!value.matches("[A-Za-z0-9._-]+(:[0-9]{1,5})?")) return null;
        if (!value.contains(":")) value = value + ":" + DEFAULT_PORT;
        return "http://" + value + "/";
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (errorBox != null && errorBox.getVisibility() == View.VISIBLE) {
            finish();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
