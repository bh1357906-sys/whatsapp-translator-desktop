package com.bh.watranslator;

import android.accessibilityservice.AccessibilityService;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 核心：读 WhatsApp 聊天界面上的文字，在上面盖一层悬浮翻译面板 + “译”按钮。
 * 只读取屏幕上的文字、只往输入框里写字，从不替你点发送。
 */
public class WaAccessibilityService extends AccessibilityService {

    private static final int SHOW_INCOMING = 3;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private Prefs prefs;
    private Translator tr;
    private WindowManager wm;

    // 悬浮层
    private LinearLayout panel;
    private TextView hdrLang, hdrTone, hdrToggle;
    private LinearLayout body;
    private TextView status;
    private WindowManager.LayoutParams panelLp;
    private TextView btn;
    private WindowManager.LayoutParams btnLp;
    private TextView mic;
    private WindowManager.LayoutParams micLp;
    private static WaAccessibilityService instance;
    private boolean overlayAdded = false;
    private AlertDialog dialog;

    // 当前聊天的状态
    private String pkg = "com.whatsapp";
    private String contact = "";
    private final List<Translator.Msg> visible = new ArrayList<>();
    private final List<String> incoming = new ArrayList<>();
    private final Map<String, String[]> readCache = new LinkedHashMap<String, String[]>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String[]> e) { return size() > 300; }
    };
    private final Set<String> pending = new HashSet<>();
    private boolean translatingOut = false;
    private String outOriginal = null;   // 翻译前的原文（用于撤销）
    private String outInserted = null;   // 我们写进输入框的译文
    private String outInfo = null;       // 状态栏文字
    private String outBack = null;       // 回译

    private final Runnable scanTask = this::scan;
    private SharedPreferences.OnSharedPreferenceChangeListener prefListener;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        prefs = new Prefs(this);
        tr = new Translator(prefs);
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        buildOverlay();
        prefListener = (sp, key) -> main.post(() -> { render(); scheduleScan(50); });
        prefs.raw().registerOnSharedPreferenceChangeListener(prefListener);
        instance = this;
    }

    /** 说中文识别完成：交给悬浮服务填进 WhatsApp 输入框。服务没开时返回 false */
    public static boolean deliverDictation(String text) {
        WaAccessibilityService s = instance;
        if (s == null) return false;
        s.main.postDelayed(() -> s.insertDictation(text, 0), 450);
        return true;
    }

    private void insertDictation(String said, int attempt) {
        AccessibilityNodeInfo entry = findEntry();
        if (entry == null) {
            // 刚从录音窗口回来，WhatsApp 还没完全回到前台：再等一下
            if (attempt < 8) main.postDelayed(() -> insertDictation(said, attempt + 1), 300);
            else toast("没找到 WhatsApp 输入框，已识别：" + said);
            return;
        }
        String cur = entryText(entry);
        if (outInserted != null && cur.equals(outInserted)) cur = ""; // 输入框里是上一次的译文，不拼接
        String joined = cur.isEmpty() ? said : cur + (cur.matches(".*[\\u3000-\\u9fff\\uff00-\\uffef]$") ? "" : " ") + said;
        clearOutgoingState();
        if (!setText(entry, joined)) {
            toast("没能写入输入框，已识别：" + said);
            return;
        }
        if (prefs.voiceAutoTranslate()) onTranslateTap();
        else render();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || prefs == null) return;
        CharSequence p = event.getPackageName();
        if (p != null && getPackageName().contentEquals(p)) return; // 自己的悬浮窗
        if (!isWhatsApp(p)) {
            // 别的 App：只在切换窗口时检查一下，好把悬浮层藏起来
            if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
            if (!overlayAdded || panel.getVisibility() != View.VISIBLE) return;
        }
        scheduleScan(event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ? 120 : 280);
    }

    private void scheduleScan(long delay) {
        main.removeCallbacks(scanTask);
        main.postDelayed(scanTask, delay);
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        main.removeCallbacksAndMessages(null);
        pool.shutdownNow();
        if (prefs != null && prefListener != null) prefs.raw().unregisterOnSharedPreferenceChangeListener(prefListener);
        removeOverlay();
        super.onDestroy();
    }

    // ================= 读界面 =================

    private static boolean isWhatsApp(CharSequence p) {
        return p != null && ("com.whatsapp".contentEquals(p) || "com.whatsapp.w4b".contentEquals(p));
    }

    private AccessibilityNodeInfo findOne(AccessibilityNodeInfo root, String id) {
        List<AccessibilityNodeInfo> l = root.findAccessibilityNodeInfosByViewId(pkg + ":id/" + id);
        return l == null || l.isEmpty() ? null : l.get(0);
    }

    private AccessibilityNodeInfo findEntry() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || !isWhatsApp(root.getPackageName())) return null;
        return findOne(root, "entry");
    }

    private static String entryText(AccessibilityNodeInfo entry) {
        if (entry == null) return "";
        if (Build.VERSION.SDK_INT >= 26 && entry.isShowingHintText()) return "";
        CharSequence t = entry.getText();
        return t == null ? "" : t.toString();
    }

    private void scan() {
        AccessibilityNodeInfo root;
        try { root = getRootInActiveWindow(); } catch (Exception e) { root = null; }
        if (root == null) return; // 暂时拿不到窗口：保持现状，等下一次事件
        if (!isWhatsApp(root.getPackageName())) {
            // 输入法、系统弹窗不算离开 WhatsApp；只有切到别的 App 才隐藏
            CharSequence rp = root.getPackageName();
            if (rp != null && !rp.toString().contains("inputmethod") && !rp.toString().contains("keyboard")) hideOverlay();
            return;
        }
        pkg = root.getPackageName().toString();
        if (!prefs.enabled()) { hideOverlay(); return; }

        AccessibilityNodeInfo entry = findOne(root, "entry");
        if (entry == null) { hideOverlay(); return; } // 不在聊天页面

        // 联系人
        String name = "";
        AccessibilityNodeInfo cn = findOne(root, "conversation_contact_name");
        if (cn != null && cn.getText() != null) name = cn.getText().toString().trim();
        if (!name.equals(contact)) {
            contact = name;
            clearOutgoingState();
        }

        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        int screenW = dm.widthPixels;

        Rect er = new Rect();
        entry.getBoundsInScreen(er);

        // 顶部栏的下边缘：面板放在它下面
        int headerBottom = dp(80);
        AccessibilityNodeInfo tb = findOne(root, "toolbar");
        if (tb == null) tb = cn;
        if (tb != null) {
            Rect r = new Rect();
            tb.getBoundsInScreen(r);
            if (r.bottom > 0 && r.bottom < er.top) headerBottom = r.bottom + (tb == cn ? dp(14) : 0);
        }

        // 消息
        visible.clear();
        incoming.clear();
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId(pkg + ":id/message_text");
        List<Object[]> items = new ArrayList<>();
        if (nodes != null) {
            for (AccessibilityNodeInfo n : nodes) {
                CharSequence t = n.getText();
                if (t == null || t.toString().trim().isEmpty()) continue;
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (r.bottom <= headerBottom || r.top >= er.top || r.width() <= 0) continue;
                int leftGap = r.left;
                int rightGap = screenW - r.right;
                boolean them = leftGap < rightGap; // 对方的气泡靠左，自己的靠右
                items.add(new Object[]{r.top, them, t.toString().trim()});
            }
        }
        items.sort((a, b) -> Integer.compare((Integer) a[0], (Integer) b[0]));
        for (Object[] it : items) {
            boolean them = (Boolean) it[1];
            String text = (String) it[2];
            visible.add(new Translator.Msg(!them, text));
            if (them) incoming.add(text);
        }
        while (incoming.size() > SHOW_INCOMING) incoming.remove(0);

        // 发出去之后（输入框清空或被改动），清掉“已翻译”提示
        String cur = entryText(entry);
        if (outInserted != null && !cur.equals(outInserted)) clearOutgoingState();

        if (prefs.autoIncoming()) for (String s : incoming) requestRead(s);

        // 按钮位置：发送键（或麦克风）的正上方
        Rect anchor = null;
        AccessibilityNodeInfo send = findOne(root, "send");
        if (send == null) send = findOne(root, "voice_note_btn");
        if (send != null) { anchor = new Rect(); send.getBoundsInScreen(anchor); }
        int size = dp(46);
        int bx = anchor != null ? anchor.centerX() - size / 2 : screenW - size - dp(8);
        int by = (anchor != null ? Math.min(anchor.top, er.top) : er.top) - size - dp(10);

        showOverlay(headerBottom + dp(4), bx, by, screenW);
        render();
    }

    private List<Translator.Msg> contextBefore(String text) {
        if (!prefsUseContext()) return null;
        List<Translator.Msg> ctx = new ArrayList<>();
        for (Translator.Msg m : visible) {
            if (!m.me && m.text.equals(text)) break;
            ctx.add(m);
        }
        return ctx;
    }

    private boolean prefsUseContext() { return prefs.raw().getBoolean("useContext", true); }

    // ================= 翻译 =================

    private void requestRead(final String text) {
        if (readCache.containsKey(text) || pending.contains(text)) return;
        pending.add(text);
        final List<Translator.Msg> ctx = contextBefore(text);
        final String who = contact;
        pool.execute(() -> {
            String[] res;
            String detected = null;
            try {
                Translator.Result r = tr.translateIncoming(text, ctx);
                if (r == null) res = new String[]{"same", ""};
                else { res = new String[]{"ok", r.text}; detected = r.lang; }
            } catch (Exception e) {
                res = new String[]{"err", String.valueOf(e.getMessage())};
            }
            final String[] fr = res;
            final String fd = detected;
            main.post(() -> {
                pending.remove(text);
                readCache.put(text, fr); // 失败的点一下可重试
                if (fd != null && !who.isEmpty() && !fd.equals(prefs.myLang()) && prefs.autoDetect()) {
                    prefs.setContactAutoLang(who, fd);
                }
                render();
            });
        });
    }

    private void onTranslateTap() {
        if (translatingOut) return;
        AccessibilityNodeInfo entry = findEntry();
        if (entry == null) return;
        final String src = entryText(entry).trim();
        if (src.isEmpty()) {
            toast("先在输入框里打字，再点“译”");
            return;
        }
        if (src.equals(outInserted)) {
            toast("已经翻译过了；要改回原文请点“撤销”");
            return;
        }
        final String target = prefs.contactLang(contact);
        final String tone = prefs.contactTone(contact);
        final List<Translator.Msg> ctx = prefsUseContext() ? new ArrayList<>(visible) : null;
        translatingOut = true;
        outInfo = "正在翻译成 " + Langs.label(target) + "…";
        outBack = null;
        render();
        pool.execute(() -> {
            try {
                final String out = tr.translateOutgoing(src, target, tone, ctx);
                main.post(() -> {
                    translatingOut = false;
                    AccessibilityNodeInfo e2 = findEntry();
                    if (e2 == null || !setText(e2, out)) {
                        outInfo = "✗ 没能写入输入框，请重新点一下输入框再试";
                        render();
                        return;
                    }
                    outOriginal = src;
                    outInserted = out;
                    outInfo = "✓ 已译成 " + Langs.label(target) + "，检查后自己点发送";
                    render();
                    if (prefs.raw().getBoolean("backTranslate", true)) requestBack(out);
                });
            } catch (Exception ex) {
                main.post(() -> {
                    translatingOut = false;
                    outInfo = "✗ 翻译失败：" + ex.getMessage();
                    render();
                });
            }
        });
    }

    private void requestBack(final String text) {
        pool.execute(() -> {
            String b;
            try { b = tr.backTranslate(text); } catch (Exception e) { b = null; }
            final String fb = b;
            main.post(() -> {
                if (text.equals(outInserted)) { outBack = fb; render(); }
            });
        });
    }

    private void undo() {
        if (outOriginal == null) return;
        AccessibilityNodeInfo e = findEntry();
        String orig = outOriginal;
        clearOutgoingState();
        if (e != null) setText(e, orig);
        render();
    }

    private boolean setText(AccessibilityNodeInfo node, String text) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (ok) {
            Bundle sel = new Bundle();
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, text.length());
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length());
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        }
        return ok;
    }

    private void clearOutgoingState() {
        outOriginal = null;
        outInserted = null;
        outBack = null;
        if (!translatingOut) outInfo = null;
    }

    // ================= 悬浮层 =================

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private static GradientDrawable round(int color, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radius);
        return g;
    }

    private TextView chip(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(13);
        t.setTextColor(0xFF075E54);
        t.setPadding(dp(10), dp(5), dp(10), dp(5));
        t.setBackground(round(0xFFE7F5EF, dp(14)));
        t.setSingleLine(true);
        return t;
    }

    private void buildOverlay() {
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(10), dp(8), dp(10), dp(8));
        GradientDrawable bg = round(0xF7FFFFFF, dp(12));
        bg.setStroke(dp(1), 0x3300A884);
        panel.setBackground(bg);
        panel.setElevation(dp(6));

        LinearLayout hdr = new LinearLayout(this);
        hdr.setOrientation(LinearLayout.HORIZONTAL);
        hdr.setGravity(Gravity.CENTER_VERTICAL);
        hdrLang = chip("");
        hdrTone = chip("");
        hdrToggle = chip("收起");
        hdrToggle.setTextColor(0xFF667781);
        hdrToggle.setBackground(round(0xFFF0F2F5, dp(14)));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(-2, -2);
        gap.rightMargin = dp(6);
        hdr.addView(hdrLang, gap);
        hdr.addView(hdrTone, new LinearLayout.LayoutParams(gap));
        View spacer = new View(this);
        hdr.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));
        hdr.addView(hdrToggle);
        panel.addView(hdr);

        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        panel.addView(body);

        status = new TextView(this);
        status.setTextSize(13);
        status.setPadding(0, dp(6), 0, 0);
        panel.addView(status);

        hdrLang.setOnClickListener(v -> pickLang());
        hdrTone.setOnClickListener(v -> pickTone());
        hdrToggle.setOnClickListener(v -> { prefs.setPanelCollapsed(!prefs.panelCollapsed()); render(); });
        status.setOnClickListener(v -> { if (outOriginal != null) undo(); });

        btn = new TextView(this);
        btn.setText("译");
        btn.setTextSize(18);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(Color.WHITE);
        btn.setGravity(Gravity.CENTER);
        GradientDrawable bb = new GradientDrawable();
        bb.setShape(GradientDrawable.OVAL);
        bb.setColor(0xFF00A884);
        btn.setBackground(bb);
        btn.setElevation(dp(6));
        btn.setOnClickListener(v -> onTranslateTap());
        btn.setOnLongClickListener(v -> { pickLang(); return true; });

        mic = new TextView(this);
        mic.setText("🎤");
        mic.setTextSize(18);
        mic.setGravity(Gravity.CENTER);
        GradientDrawable mb = new GradientDrawable();
        mb.setShape(GradientDrawable.OVAL);
        mb.setColor(0xFF1E88E5);
        mic.setBackground(mb);
        mic.setElevation(dp(6));
        mic.setOnClickListener(v -> startDictation());

        int type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY;
        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        panelLp = new WindowManager.LayoutParams(-1, -2, type, flags, PixelFormat.TRANSLUCENT);
        panelLp.gravity = Gravity.TOP | Gravity.START;
        btnLp = new WindowManager.LayoutParams(dp(46), dp(46), type, flags, PixelFormat.TRANSLUCENT);
        btnLp.gravity = Gravity.TOP | Gravity.START;
        micLp = new WindowManager.LayoutParams(dp(42), dp(42), type, flags, PixelFormat.TRANSLUCENT);
        micLp.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= 28) {
            micLp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            panelLp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            btnLp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    private void showOverlay(int panelY, int bx, int by, int screenW) {
        int margin = dp(8);
        panelLp.width = screenW - margin * 2;
        panelLp.x = margin;
        panelLp.y = panelY;
        btnLp.x = Math.max(0, Math.min(bx, screenW - btnLp.width));
        btnLp.y = Math.max(panelY, by);
        // 🎤 在“译”的左边
        micLp.x = Math.max(0, btnLp.x - micLp.width - dp(10));
        micLp.y = btnLp.y;
        try {
            if (!overlayAdded) {
                wm.addView(panel, panelLp);
                wm.addView(btn, btnLp);
                wm.addView(mic, micLp);
                overlayAdded = true;
            } else {
                wm.updateViewLayout(panel, panelLp);
                wm.updateViewLayout(btn, btnLp);
                wm.updateViewLayout(mic, micLp);
            }
            panel.setVisibility(View.VISIBLE);
            btn.setVisibility(View.VISIBLE);
            mic.setVisibility(prefs.voiceButton() ? View.VISIBLE : View.GONE);
        } catch (Exception ignored) {}
    }

    private void hideOverlay() {
        if (!overlayAdded) return;
        panel.setVisibility(View.GONE);
        btn.setVisibility(View.GONE);
        mic.setVisibility(View.GONE);
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
    }

    private void removeOverlay() {
        if (!overlayAdded) return;
        try { wm.removeView(panel); } catch (Exception ignored) {}
        try { wm.removeView(btn); } catch (Exception ignored) {}
        try { wm.removeView(mic); } catch (Exception ignored) {}
        overlayAdded = false;
    }

    private void render() {
        if (panel == null || prefs == null) return;
        String target = prefs.contactLang(contact);
        String langText = "对方：" + Langs.label(target);
        if (prefs.contactLangIsAuto(contact)) langText += "（自动）";
        hdrLang.setText(langText + " ▾");
        int ti = Prefs.toneIndex(prefs.contactTone(contact));
        hdrTone.setText("语气：" + Prefs.TONE_LABELS[ti < 0 ? 0 : ti] + " ▾");
        boolean collapsed = prefs.panelCollapsed();
        hdrToggle.setText(collapsed ? "展开" : "收起");
        btn.setAlpha(translatingOut ? 0.5f : 1f);
        btn.setText(translatingOut ? "…" : "译");

        body.removeAllViews();
        if (!collapsed && prefs.autoIncoming()) {
            int shown = 0;
            for (String src : incoming) {
                String[] r = readCache.get(src);
                String line;
                int color = 0xFF111B21;
                if (r == null) { line = "翻译中…  " + ellipsize(src, 30); color = 0xFF8696A0; }
                else if ("same".equals(r[0])) continue;
                else if ("err".equals(r[0])) { line = "✗ " + r[1]; color = 0xFFC62828; }
                else line = r[1];
                TextView t = new TextView(this);
                t.setText(line);
                t.setTextSize(15);
                t.setTextColor(color);
                t.setMaxLines(4);
                t.setEllipsize(TextUtils.TruncateAt.END);
                t.setPadding(0, dp(6), 0, 0);
                if (r != null && "err".equals(r[0])) {
                    t.setOnClickListener(v -> { readCache.remove(src); requestRead(src); render(); });
                }
                // 长按：查看原文
                t.setOnLongClickListener(v -> { toast("原文：" + src); return true; });
                body.addView(t);
                shown++;
            }
            if (shown == 0 && !incoming.isEmpty()) {
                TextView t = new TextView(this);
                t.setText("对方最近的消息不用翻译");
                t.setTextSize(13);
                t.setTextColor(0xFF8696A0);
                t.setPadding(0, dp(6), 0, 0);
                body.addView(t);
            }
        }

        if (outInfo != null) {
            StringBuilder sb = new StringBuilder(outInfo);
            if (outBack != null && !outBack.isEmpty()) sb.append("\n意思：").append(outBack);
            if (outOriginal != null) sb.append("\n点这里撤销，改回原文");
            status.setText(sb.toString());
            status.setTextColor(outInfo.startsWith("✗") ? 0xFFC62828 : 0xFF00875F);
            status.setVisibility(View.VISIBLE);
        } else {
            status.setVisibility(View.GONE);
        }
    }

    private static String ellipsize(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    private void startDictation() {
        if (prefs.sttKey().isEmpty()) {
            toast("先打开「WA 翻译助手」App，在“语音”里填写语音识别的 Key");
            return;
        }
        Intent i = new Intent(this, VoiceInputActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        try { startActivity(i); } catch (Exception e) { toast("打不开录音窗口：" + e.getMessage()); }
    }

    // ================= 选择语言 / 语气 =================

    private AlertDialog.Builder dialogBuilder() {
        return new AlertDialog.Builder(new ContextThemeWrapper(this, android.R.style.Theme_Material_Light_Dialog_Alert));
    }

    private void showDialog(AlertDialog d) {
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
        dialog = d;
        if (d.getWindow() != null) d.getWindow().setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY);
        try { d.show(); } catch (Exception e) { toast("打不开选择框：" + e.getMessage()); }
    }

    private void pickLang() {
        if (contact.isEmpty()) { toast("没认出联系人名字，先打开一个聊天"); }
        final String who = contact;
        String[] labels = Langs.labels();
        String[] items = new String[labels.length + 1];
        items[0] = "自动识别（按对方发来的语言）";
        System.arraycopy(labels, 0, items, 1, labels.length);
        int checked = prefs.contactLangIsManual(who) ? Langs.indexOf(prefs.contactLang(who)) + 1 : 0;
        AlertDialog d = dialogBuilder()
                .setTitle(who.isEmpty() ? "对方语言" : "和「" + who + "」聊天用的语言")
                .setSingleChoiceItems(items, checked, (di, which) -> {
                    prefs.setContactLang(who, which == 0 ? null : Langs.LIST[which - 1][0]);
                    di.dismiss();
                    render();
                })
                .setNegativeButton("取消", null)
                .create();
        showDialog(d);
    }

    private void pickTone() {
        final String who = contact;
        int checked = Math.max(0, Prefs.toneIndex(prefs.contactTone(who)));
        AlertDialog d = dialogBuilder()
                .setTitle("发给对方时的语气")
                .setSingleChoiceItems(Prefs.TONE_LABELS, checked, (di, which) -> {
                    prefs.setContactTone(who, Prefs.TONES[which]);
                    di.dismiss();
                    render();
                })
                .setNegativeButton("取消", null)
                .create();
        showDialog(d);
    }
}
