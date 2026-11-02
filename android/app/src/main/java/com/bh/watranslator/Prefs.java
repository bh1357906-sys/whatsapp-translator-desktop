package com.bh.watranslator;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** 设置读写。API Key 用安卓系统密钥库（Keystore）加密后保存。 */
public final class Prefs {
    public static final String[] ENGINES = {"deepseek", "openai", "gemini", "custom"};
    public static final String[] ENGINE_LABELS = {"DeepSeek", "OpenAI", "Google Gemini", "自定义（OpenAI 兼容接口）"};
    public static final String[] ENGINE_BASE = {"https://api.deepseek.com", "https://api.openai.com/v1", "https://generativelanguage.googleapis.com/v1beta/openai", ""};
    public static final String[] ENGINE_MODEL = {"deepseek-chat", "gpt-4o-mini", "gemini-2.5-flash", ""};

    // 语音识别（DeepSeek 不支持语音，需要 Groq / OpenAI 的 Key）
    public static final String[] STT_ENGINES = {"groq", "openai", "custom"};
    public static final String[] STT_LABELS = {"Groq（Whisper，便宜，有免费额度）", "OpenAI（和翻译共用 OpenAI 的 Key）", "自定义（OpenAI 兼容接口）"};
    public static final String[] STT_BASE = {"https://api.groq.com/openai/v1", "https://api.openai.com/v1", ""};
    public static final String[] STT_MODEL = {"whisper-large-v3-turbo", "gpt-4o-mini-transcribe", "whisper-1"};
    public static final String[] STT_KEYNAME = {"stt_groq", "openai", "stt_custom"};

    public static final String[] TONES = {"casual", "formal", "warm", "brief"};
    public static final String[] TONE_LABELS = {"日常口语", "正式商务", "亲切热情", "简短直接"};

    private static final String KEY_ALIAS = "wa_translator_api_key";
    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        sp = ctx.getApplicationContext().getSharedPreferences("settings", Context.MODE_PRIVATE);
    }

    public SharedPreferences raw() { return sp; }

    // ---------- 基本设置 ----------
    public String engine() {
        String e = sp.getString("engine", "deepseek");
        return engineIndex(e) >= 0 ? e : "deepseek";
    }
    public static int engineIndex(String e) {
        for (int i = 0; i < ENGINES.length; i++) if (ENGINES[i].equals(e)) return i;
        return -1;
    }
    public String apiBase() {
        String custom = sp.getString("apiBase", "").trim();
        if ("custom".equals(engine()) || !custom.isEmpty()) {
            if (!custom.isEmpty()) return trimSlash(custom);
        }
        return ENGINE_BASE[engineIndex(engine())];
    }
    public String model() {
        String m = sp.getString("model", "").trim();
        return m.isEmpty() ? ENGINE_MODEL[engineIndex(engine())] : m;
    }
    public String myLang() { return sp.getString("myLang", "Simplified Chinese"); }
    public String defaultTheirLang() { return sp.getString("defaultTheirLang", "English"); }
    public String defaultTone() { return sp.getString("tone", "casual"); }
    public String glossary() { return sp.getString("glossary", ""); }
    public boolean autoIncoming() { return sp.getBoolean("autoIncoming", true); }
    public boolean autoDetect() { return sp.getBoolean("autoDetect", true); }
    public boolean enabled() { return sp.getBoolean("enabled", true); }
    public void setEnabled(boolean on) { sp.edit().putBoolean("enabled", on).apply(); }
    public boolean panelCollapsed() { return sp.getBoolean("panelCollapsed", false); }
    public void setPanelCollapsed(boolean v) { sp.edit().putBoolean("panelCollapsed", v).apply(); }

    // ---------- 语音 ----------
    public int sttIndex() {
        String e = sp.getString("sttEngine", "groq");
        for (int i = 0; i < STT_ENGINES.length; i++) if (STT_ENGINES[i].equals(e)) return i;
        return 0;
    }
    public String sttBase() {
        String b = sp.getString("sttApiBase", "").trim();
        return b.isEmpty() ? STT_BASE[sttIndex()] : trimSlash(b);
    }
    public String sttModel() {
        String m = sp.getString("sttModel", "").trim();
        return m.isEmpty() ? STT_MODEL[sttIndex()] : m;
    }
    public String sttKey() { return key(STT_KEYNAME[sttIndex()]); }
    public boolean voiceAutoTranslate() { return sp.getBoolean("voiceAutoTranslate", true); }
    /** 译文显示位置：under = 贴在每条消息下面（默认），top = 顶部面板 */
    public boolean underMode() { return !"top".equals(sp.getString("transPos", "under")); }
    public boolean showOwn() { return sp.getBoolean("showOwn", true); }
    public boolean autoSend() { return sp.getBoolean("autoSend", true); }
    public boolean voiceButton() { return sp.getBoolean("voiceButton", true); }

    private static String trimSlash(String s) {
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    // ---------- 每个联系人：语言 / 语气 ----------
    private JSONObject contacts() {
        try { return new JSONObject(sp.getString("contacts", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    private JSONObject contact(String name) {
        JSONObject c = contacts().optJSONObject(name);
        return c == null ? new JSONObject() : c;
    }
    private void putContact(String name, String key, String value) {
        if (name == null || name.isEmpty()) return;
        try {
            JSONObject all = contacts();
            JSONObject c = all.optJSONObject(name);
            if (c == null) c = new JSONObject();
            if (value == null) c.remove(key); else c.put(key, value);
            all.put(name, c);
            sp.edit().putString("contacts", all.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** 对方语言：手动设置 > 自动识别 > 默认 */
    public String contactLang(String name) {
        JSONObject c = contact(name);
        String manual = c.optString("lang", "");
        if (Langs.known(manual)) return manual;
        String auto = c.optString("autoLang", "");
        if (Langs.known(auto)) return auto;
        return defaultTheirLang();
    }
    public boolean contactLangIsManual(String name) { return Langs.known(contact(name).optString("lang", "")); }
    public boolean contactLangIsAuto(String name) {
        return !contactLangIsManual(name) && Langs.known(contact(name).optString("autoLang", ""));
    }
    public void setContactLang(String name, String lang) { putContact(name, "lang", lang); }
    public void setContactAutoLang(String name, String lang) {
        if (!contact(name).optString("autoLang", "").equals(lang)) putContact(name, "autoLang", lang);
    }
    public String contactTone(String name) {
        String t = contact(name).optString("tone", "");
        return toneIndex(t) >= 0 ? t : defaultTone();
    }
    public void setContactTone(String name, String tone) { putContact(name, "tone", tone); }
    public static int toneIndex(String t) {
        for (int i = 0; i < TONES.length; i++) if (TONES[i].equals(t)) return i;
        return -1;
    }

    // ---------- 用量 ----------
    public void addUsage(int tokens) {
        String day = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date());
        boolean same = day.equals(sp.getString("usageDay", ""));
        int today = same ? sp.getInt("usageToday", 0) : 0;
        int calls = same ? sp.getInt("usageTodayCalls", 0) : 0;
        sp.edit()
                .putString("usageDay", day)
                .putInt("usageToday", today + tokens)
                .putInt("usageTodayCalls", calls + 1)
                .putLong("usageTotal", sp.getLong("usageTotal", 0) + tokens)
                .apply();
    }

    // ---------- API Key（加密保存） ----------
    public String apiKey() { return key(engine()); }

    /** 按名字取 Key：翻译引擎名（deepseek/openai/...）或语音的 stt_groq / stt_custom */
    public String key(String name) {
        String enc = sp.getString("apiKey_" + name, "");
        if (enc.isEmpty()) return "";
        try { return decrypt(enc); } catch (Exception e) { return ""; }
    }
    public boolean hasApiKey(String engine) { return !sp.getString("apiKey_" + engine, "").isEmpty(); }
    public void setApiKey(String engine, String key) {
        String k = key == null ? "" : key.trim();
        try {
            sp.edit().putString("apiKey_" + engine, k.isEmpty() ? "" : encrypt(k)).apply();
        } catch (Exception e) {
            // 极少数机型密钥库不可用：退回到仅应用私有存储
            sp.edit().putString("apiKey_" + engine, k.isEmpty() ? "" : "plain:" + k).apply();
        }
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return kg.generateKey();
    }
    private static String encrypt(String text) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
        return "gcm:" + Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }
    private static String decrypt(String s) throws Exception {
        if (s.startsWith("plain:")) return s.substring(6);
        String[] p = s.split(":");
        if (p.length != 3 || !"gcm".equals(p[0])) return "";
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(p[1], Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(p[2], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
