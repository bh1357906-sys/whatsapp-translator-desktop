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
    private CheckBox enabled, autoIncoming, autoDetect, useContext, backTranslate;
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

        section("④ 词库（固定译法）");
        text("每行一条：原文 = 译法。例如：发货 = shipping", 13);
        glossary = edit(prefs.glossary(), true);

        Button saveBtn = button("保存设置");
        saveBtn.setOnClickListener(v -> save(true));

        section("用法");
        text("1. 打开 WhatsApp 进入任意聊天，顶部会出现翻译面板，显示对方最近几条消息的中文意思。\n"
                + "2. 在输入框里打中文，点绿色「译」按钮，输入框里的字会变成对方的语言，确认后自己点发送。\n"
                + "3. 面板上的「对方：xx语」可以给每个联系人单独选语言；长按「译」也能选。\n"
                + "4. 点“撤销”提示可以改回原文；长按某条翻译可以看原文；翻译失败的点一下重试。\n"
                + "5. 本应用不会替你点发送，也不会把聊天内容发到你填写的翻译接口以外的地方。", 14);

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
                .apply();
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
