package com.bh.watranslator;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.nio.file.Files;

/**
 * 说中文：在 WhatsApp 聊天里点悬浮的 🎤 → 这里录音 → 识别成文字 →
 * 交回悬浮服务，填进输入框并翻译成对方语言（不会自动发送）。
 */
public class VoiceInputActivity extends Activity {

    private static final int REQ_MIC = 7;
    private static final int MAX_MS = 60000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaRecorder recorder;
    private File file;
    private long t0;
    private boolean busy = false;
    private TextView status;
    private Button done;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (recorder == null) return;
            long s = (System.currentTimeMillis() - t0) / 1000;
            status.setText(String.format(java.util.Locale.US, "🎤 正在听…  %d:%02d\n说完点「完成」", s / 60, s % 60));
            main.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("说" + Langs.label(new Prefs(this).myLang()));
        setFinishOnTouchOutside(false);
        int p = Math.round(18 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(p, p, p, p);
        status = new TextView(this);
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        status.setTextColor(0xFF111B21);
        status.setMinWidth(Math.round(260 * getResources().getDisplayMetrics().density));
        root.addView(status);
        LinearLayout btns = new LinearLayout(this);
        btns.setPadding(0, p, 0, 0);
        Button cancel = new Button(this);
        cancel.setText("取消");
        done = new Button(this);
        done.setText("完成");
        btns.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1f));
        btns.addView(done, new LinearLayout.LayoutParams(0, -2, 1f));
        root.addView(btns);
        setContentView(root);
        cancel.setOnClickListener(v -> { stopRecorder(); finish(); });
        done.setOnClickListener(v -> finishRecording());

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) start();
        else {
            status.setText("需要麦克风权限才能听你说话");
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) start();
        else {
            Toast.makeText(this, "没有麦克风权限，无法录音（可在系统设置 → 应用 → WA 翻译助手 → 权限里打开）", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @SuppressWarnings("deprecation")
    private void start() {
        try {
            file = new File(getCacheDir(), "dictation.m4a");
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setAudioChannels(1);
            recorder.setMaxDuration(MAX_MS);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.setOnInfoListener((mr, what, extra) -> {
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) finishRecording();
            });
            recorder.prepare();
            recorder.start();
            t0 = System.currentTimeMillis();
            main.post(tick);
        } catch (Exception e) {
            stopRecorder();
            Toast.makeText(this, "录音失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
        }
    }

    private void stopRecorder() {
        main.removeCallbacks(tick);
        if (recorder == null) return;
        try { recorder.stop(); } catch (Exception ignored) {}
        try { recorder.release(); } catch (Exception ignored) {}
        recorder = null;
    }

    private void finishRecording() {
        if (busy || recorder == null) return;
        long dur = System.currentTimeMillis() - t0;
        stopRecorder();
        if (dur < 700) {
            Toast.makeText(this, "录音太短了，请再说一次", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        busy = true;
        done.setEnabled(false);
        status.setText("🎤 识别中…");
        new Thread(() -> {
            String said = null, err = null;
            try {
                byte[] data = Files.readAllBytes(file.toPath());
                Prefs prefs = new Prefs(this);
                said = new Translator(prefs).transcribe(data, "m4a", Translator.sttLang(prefs.myLang()));
            } catch (Exception e) {
                err = e.getMessage();
            }
            final String fs = said, fe = err;
            main.post(() -> {
                if (fe != null) {
                    status.setText("✗ " + fe);
                    busy = false;
                    return;
                }
                if (fs == null || fs.isEmpty()) {
                    Toast.makeText(this, "没听清，请再说一次", Toast.LENGTH_SHORT).show();
                    finish();
                    return;
                }
                if (!WaAccessibilityService.deliverDictation(fs)) {
                    // 悬浮服务没开：复制到剪贴板
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("语音", fs));
                    Toast.makeText(this, "已复制：" + fs, Toast.LENGTH_LONG).show();
                }
                finish();
            });
        }).start();
    }

    @Override
    protected void onDestroy() {
        stopRecorder();
        if (file != null) //noinspection ResultOfMethodCallIgnored
            file.delete();
        super.onDestroy();
    }
}
