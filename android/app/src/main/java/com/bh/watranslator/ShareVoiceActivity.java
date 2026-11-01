package com.bh.watranslator;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 别人发来的语音：在 WhatsApp / Telegram 里长按语音 →「分享」→ 选「WA 翻译助手」，
 * 这里识别说了什么并翻译成我的语言。
 */
public class ShareVoiceActivity extends Activity {

    private TextView status, transcript, translation;
    private Button copy;
    private String resultText = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("语音翻译");
        int p = Math.round(18 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(p, p / 2, p, p);
        status = new TextView(this);
        status.setTextSize(14);
        status.setTextColor(0xFF667781);
        transcript = new TextView(this);
        transcript.setTextSize(14);
        transcript.setTextColor(0xFF8696A0);
        transcript.setTextIsSelectable(true);
        transcript.setPadding(0, p / 2, 0, 0);
        translation = new TextView(this);
        translation.setTextSize(18);
        translation.setTextColor(0xFF111B21);
        translation.setTypeface(Typeface.DEFAULT_BOLD);
        translation.setTextIsSelectable(true);
        translation.setPadding(0, p / 2, 0, 0);
        root.addView(status);
        root.addView(transcript);
        root.addView(translation);
        LinearLayout btns = new LinearLayout(this);
        btns.setPadding(0, p, 0, 0);
        copy = new Button(this);
        copy.setText("复制");
        copy.setEnabled(false);
        Button close = new Button(this);
        close.setText("关闭");
        btns.addView(copy, new LinearLayout.LayoutParams(0, -2, 1f));
        btns.addView(close, new LinearLayout.LayoutParams(0, -2, 1f));
        root.addView(btns);
        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
        close.setOnClickListener(v -> finish());
        copy.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("翻译", resultText));
            Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
        });
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    @SuppressWarnings("deprecation")
    private Uri streamOf(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private void handle(Intent intent) {
        Uri uri = intent == null ? null : streamOf(intent);
        if (uri == null && intent != null && intent.getClipData() != null && intent.getClipData().getItemCount() > 0) {
            uri = intent.getClipData().getItemAt(0).getUri();
        }
        if (uri == null) {
            status.setText("没有收到语音文件。用法：在 WhatsApp 里长按语音 → 分享 → 选「WA 翻译助手」。");
            return;
        }
        final Uri u = uri;
        final String mime = intent.getType() != null ? intent.getType() : getContentResolver().getType(uri);
        status.setText("🎤 识别中…");
        transcript.setText("");
        translation.setText("");
        copy.setEnabled(false);
        new Thread(() -> {
            String err = null, said = null, tr = null;
            try {
                byte[] data = readAll(u);
                Translator t = new Translator(new Prefs(this));
                said = t.transcribe(data, Translator.audioExt(data, mime), "");
                if (said.isEmpty()) {
                    err = "没听到说话内容";
                } else {
                    Translator.Result r = t.translateIncoming(said, null);
                    tr = r == null ? null : r.text;
                }
            } catch (Exception e) {
                err = e.getMessage();
            }
            final String fe = err, fs = said, ft = tr;
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (fe != null && fs == null) {
                    status.setText("✗ " + fe);
                    status.setTextColor(0xFFC62828);
                    return;
                }
                status.setText(fe != null ? "✗ " + fe : "✓ 识别完成");
                transcript.setText(fs == null ? "" : "🎤 " + fs);
                resultText = ft != null ? ft : (fs == null ? "" : fs);
                translation.setText(ft != null ? ft : "（已经是你的语言，不用翻译）");
                copy.setEnabled(!resultText.isEmpty());
            });
        }).start();
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream is = getContentResolver().openInputStream(uri)) {
            if (is == null) throw new Exception("打不开这个语音文件");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (bo.size() > 20 * 1024 * 1024) throw new Exception("语音太长（超过 20MB）");
            }
            return bo.toByteArray();
        }
    }
}
