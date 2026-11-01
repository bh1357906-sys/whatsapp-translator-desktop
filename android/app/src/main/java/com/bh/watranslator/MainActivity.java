package com.bh.watranslator;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

/** 设置页 + 开启引导（界面全部用代码搭，不依赖额外的库） */
public class MainActivity extends Activity {

    private Prefs prefs;
    private LinearLayout root;
    private TextView statusText, usageText, testResult;
    private Button openA11y;
    private Spinner engine, myLang, theirLang, tone;
    private EditText apiKey, apiBase, model, glossary;
    private CheckBox enabled, autoIncoming, autoDetect, useContext, backTranslate, voiceButton, voiceAutoTranslate;
    private Spinner sttEngine;
    private EditText sttKey, sttBase, sttModel;
    private TextView sttResult;
    private int lastStt = -1;
    private int lastEngine = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        setTitle("WA 翻译助手");

        ScrollView sv = new ScrollView(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(12), dp(18), dp(40));
        sv.addView(root);
        setContentView(sv);

        // ---- 开启状态 ----
        section("① 开启悬浮翻译");
        statusText = text("", 15);
        openA11y = button("打开无障碍设置");
        openA11y.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        text("在“无障碍”里找到「已下载的应用 / 已安装的服务」→「WA 翻译助手」→ 打开。", 13);
        if (Build.VERSION.SDK_INT >= 33) {
            text("如果开关是灰色的、提示“受限制的设置”：先点下面按钮进入应用信息 → 右上角 ⋮ →「允许受限制的设置」，再回来打开。", 13);
            Button info = button("打开应用信息");
            info.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        }
        enabled = check("启用悬浮翻译（关掉后 WhatsApp 里不显示）", prefs.enabled());

        // ---- 翻译接口 ----
        section("② 翻译接口");
        label("翻译引擎");
        engine = spinner(Prefs.ENGINE_LABELS, Prefs.engineIndex(prefs.engine()));
        label("API Key");
        apiKey = edit("", false);
        apiKey.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        label("接口地址（高级，可留空用默认）");
        apiBase = edit(prefs.raw().getString("apiBase", ""), false);
        label("模型名（高级，可留空用默认）");
        model = edit(prefs.raw().getString("model", ""), false);
        Button test = button("保存并测试连接");
        testResult = text("", 13);
        test.setOnClickListener(v -> { save(false); runTest(); });
        engine.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { refreshKeyHint(); }
            @Override public void onNothingSelected(AdapterView<?> p) {}
        });

        // ---- 语言 ----
        section("③ 语言和语气");
        label("我的语言（对方的消息翻译成这个）");
        myLang = spinner(Langs.labels(), Math.max(0, Langs.indexOf(prefs.myLang())));
        label("对方默认语言（没设置过、也没自动识别出来时用这个）");
        theirLang = spinner(Langs.labels(), Math.max(0, Langs.indexOf(prefs.defaultTheirLang())));
        label("默认语气（每个联系人也可以在悬浮面板里单独改）");
        tone = spinner(Prefs.TONE_LABELS, Math.max(0, Prefs.toneIndex(prefs.defaultTone())));
        autoIncoming = check("自动翻译对方发来的消息", prefs.autoIncoming());
        autoDetect = check("自动识别对方的语言（回复时自动用对方的语言）", prefs.autoDetect());
        useContext = check("结合最近几条聊天一起理解（更准，稍费一点额度）", prefs.raw().getBoolean("useContext", true));
        backTranslate = check("翻译后显示“意思”回译，确认没翻错", prefs.raw().getBoolean("backTranslate", true));

        section("④ 语音");
        text("· 对方发来的语音：在 WhatsApp 里长按语音 →「分享」→ 选「WA 翻译助手」，会显示说了什么和中文意思。\n"
                + "· 自己说中文：聊天里点蓝色 🎤，说完点「完成」，会自动填进输入框并翻译成对方语言（不会自动发送）。\n"
                + "· DeepSeek 不能识别语音，需要另外一个 Key。推荐 Groq：到 console.groq.com 注册 → API Keys → Create，很便宜。", 13);
        voiceButton = check("在 WhatsApp 里显示 🎤 说中文按钮", prefs.voiceButton());
        voiceAutoTranslate = check("说完自动翻译成对方语言", prefs.voiceAutoTranslate());
        label("语音识别服务");
        sttEngine = spinner(Prefs.STT_LABELS, prefs.sttIndex());
        label("语音识别的 API Key");
        sttKey = edit("", false);
        sttKey.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        label("接口地址（高级，可留空用默认）");
        sttBase = edit(prefs.raw().getString("sttApiBase", ""), false);
        label("模型名（高级，可留空用默认）");
        sttModel = edit(prefs.raw().getString("sttModel", ""), false);
        Button testStt = button("保存并测试语音识别");
        sttResult = text("", 13);
        testStt.setOnClickListener(v -> { save(false); runSttTest(); });
        sttEngine.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { refreshSttHint(); }
            @Override public void onNothingSelected(AdapterView<?> p) {}
        });

        section("⑤ 词库（固定译法）");
        text("每行一条：原文 = 译法。例如：发货 = shipping", 13);
        glossary = edit(prefs.glossary(), true);

        Button saveBtn = button("保存设置");
        saveBtn.setOnClickListener(v -> save(true));

        section("用法");
        text("1. 打开 WhatsApp 进入任意聊天，顶部会出现翻译面板，显示对方最近几条消息的中文意思。\n"
                + "2. 在输入框里打中文，点绿色「译」按钮，输入框里的字会变成对方的语言，确认后自己点发送。\n"
                + "3. 面板上的「对方：xx语」可以给每个联系人单独选语言；长按「译」也能选。\n"
                + "4. 点“撤销”提示可以改回原文；长按某条翻译可以看原文；翻译失败的点一下重试。\n"
                + "5. 对方的语音：长按语音 → 分享 → WA 翻译助手；自己说中文：点蓝色 🎤。\n"
                + "6. 本应用不会替你点发送，也不会把聊天内容发到你填写的翻译接口以外的地方。", 14);

        section("用量");
        usageText = text("", 13);
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean on = serviceEnabled();
        statusText.setText(on ? "✓ 已开启。打开 WhatsApp 聊天就能用。" : "✗ 还没开启：点下面按钮，在无障碍设置里打开「WA 翻译助手」。");
        statusText.setTextColor(on ? 0xFF00875F : 0xFFC62828);
        openA11y.setText(on ? "无障碍设置（已开启）" : "打开无障碍设置");
        refreshKeyHint();
        refreshSttHint();
        usageText.setText("今天：" + prefs.raw().getInt("usageTodayCalls", 0) + " 次，约 "
                + prefs.raw().getInt("usageToday", 0) + " tokens；累计约 " + prefs.raw().getLong("usageTotal", 0) + " tokens"
                + (todayIsUsageDay() ? "" : "（今天还没用过）"));
    }

    private boolean todayIsUsageDay() {
        String day = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date());
        return day.equals(prefs.raw().getString("usageDay", ""));
    }

    private void refreshKeyHint() {
        int i = engine.getSelectedItemPosition();
        if (i == lastEngine) return;
        lastEngine = i;
        apiKey.setText("");
        apiKey.setHint(prefs.hasApiKey(Prefs.ENGINES[i]) ? "已保存（不修改请留空）" : "粘贴你的 API Key");
    }

    private void refreshSttHint() {
        int i = sttEngine.getSelectedItemPosition();
        if (i == lastStt) return;
        lastStt = i;
        sttKey.setText("");
        String name = Prefs.STT_KEYNAME[i];
        sttKey.setHint(prefs.hasApiKey(name) ? "已保存（不修改请留空）" : ("openai".equals(name) ? "OpenAI 的 Key（和翻译共用）" : "粘贴语音识别的 Key"));
    }

    private void runSttTest() {
        sttResult.setText("正在测试…");
        sttResult.setTextColor(0xFF667781);
        new Thread(() -> {
            String msg;
            boolean ok;
            try {
                msg = "✓ 语音识别可用（模型：" + new Translator(prefs).testStt() + "）";
                ok = true;
            } catch (Exception e) {
                msg = "✗ " + e.getMessage();
                ok = false;
            }
            final String m = msg;
            final boolean fok = ok;
            runOnUiThread(() -> {
                sttResult.setText(m);
                sttResult.setTextColor(fok ? 0xFF00875F : 0xFFC62828);
            });
        }).start();
    }

    private boolean serviceEnabled() {
        String s = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (s == null) return false;
        ComponentName me = new ComponentName(this, WaAccessibilityService.class);
        for (String part : s.split(":")) {
            ComponentName c = ComponentName.unflattenFromString(part);
            if (me.equals(c)) return true;
        }
        return false;
    }

    private void save(boolean showToast) {
        String eng = Prefs.ENGINES[engine.getSelectedItemPosition()];
        android.content.SharedPreferences.Editor ed = prefs.raw().edit();
        ed.putString("engine", eng)
                .putString("apiBase", apiBase.getText().toString().trim())
                .putString("model", model.getText().toString().trim())
                .putString("myLang", Langs.LIST[myLang.getSelectedItemPosition()][0])
                .putString("defaultTheirLang", Langs.LIST[theirLang.getSelectedItemPosition()][0])
                .putString("tone", Prefs.TONES[tone.getSelectedItemPosition()])
                .putString("glossary", glossary.getText().toString())
                .putBoolean("enabled", enabled.isChecked())
                .putBoolean("autoIncoming", autoIncoming.isChecked())
                .putBoolean("autoDetect", autoDetect.isChecked())
                .putBoolean("useContext", useContext.isChecked())
                .putBoolean("backTranslate", backTranslate.isChecked())
                .putBoolean("voiceButton", voiceButton.isChecked())
                .putBoolean("voiceAutoTranslate", voiceAutoTranslate.isChecked())
                .putString("sttEngine", Prefs.STT_ENGINES[sttEngine.getSelectedItemPosition()])
                .putString("sttApiBase", sttBase.getText().toString().trim())
                .putString("sttModel", sttModel.getText().toString().trim())
                .apply();
        String sk = sttKey.getText().toString().trim();
        if (!sk.isEmpty()) {
            prefs.setApiKey(Prefs.STT_KEYNAME[sttEngine.getSelectedItemPosition()], sk);
            sttKey.setText("");
            sttKey.setHint("已保存（不修改请留空）");
        }
        String k = apiKey.getText().toString().trim();
        if (!k.isEmpty()) {
            prefs.setApiKey(eng, k);
            apiKey.setText("");
            apiKey.setHint("已保存（不修改请留空）");
        }
        if (showToast) Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show();
    }

    private void runTest() {
        testResult.setText("正在连接…");
        testResult.setTextColor(0xFF667781);
        new Thread(() -> {
            String msg;
            boolean ok;
            try {
                new Translator(prefs).test();
                msg = "✓ 连接成功，可以使用";
                ok = true;
            } catch (Exception e) {
                msg = "✗ " + e.getMessage();
                ok = false;
            }
            final String m = msg;
            final boolean fok = ok;
            runOnUiThread(() -> {
                testResult.setText(m);
                testResult.setTextColor(fok ? 0xFF00875F : 0xFFC62828);
            });
        }).start();
    }

    // ---------- 简单的界面小工具 ----------
    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void section(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(17);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setTextColor(0xFF00A884);
        t.setPadding(0, dp(22), 0, dp(6));
        root.addView(t);
    }

    private void label(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(13);
        t.setTextColor(0xFF54656F);
        t.setPadding(0, dp(10), 0, dp(2));
        root.addView(t);
    }

    private TextView text(String s, int size) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(0xFF3B4A54);
        t.setLineSpacing(0, 1.2f);
        t.setPadding(0, dp(4), 0, dp(4));
        root.addView(t);
        return t;
    }

    private Button button(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        root.addView(b, lp);
        return b;
    }

    private CheckBox check(String s, boolean v) {
        CheckBox c = new CheckBox(this);
        c.setText(s);
        c.setChecked(v);
        c.setPadding(0, dp(6), 0, dp(6));
        root.addView(c);
        return c;
    }

    private EditText edit(String v, boolean multi) {
        EditText e = new EditText(this);
        e.setText(v);
        if (multi) {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            e.setMinLines(4);
            e.setGravity(android.view.Gravity.TOP);
        } else {
            e.setSingleLine(true);
        }
        root.addView(e);
        return e;
    }

    private Spinner spinner(String[] items, int sel) {
        Spinner s = new Spinner(this);
        ArrayAdapter<String> a = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, items);
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        s.setAdapter(a);
        s.setSelection(sel);
        root.addView(s);
        return s;
    }
}
