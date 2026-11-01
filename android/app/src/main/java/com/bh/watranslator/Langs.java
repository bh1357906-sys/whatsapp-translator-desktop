package com.bh.watranslator;

/** 支持的语言（和电脑版 lang.js 保持一致） */
public final class Langs {
    private Langs() {}

    public static final String[][] LIST = {
        {"English", "EN", "英语 English"},
        {"Simplified Chinese", "中", "简体中文"},
        {"Traditional Chinese", "繁", "繁体中文"},
        {"Malay", "MS", "马来语 Malay"},
        {"Indonesian", "ID", "印尼语 Indonesian"},
        {"Hindi", "HI", "印地语 Hindi"},
        {"Hinglish", "HN", "印式英语 Hinglish"},
        {"Urdu", "UR", "乌尔都语 Urdu"},
        {"Bengali", "BN", "孟加拉语 Bengali"},
        {"Tamil", "TA", "泰米尔语 Tamil"},
        {"Armenian", "HY", "亚美尼亚语 Armenian"},
        {"Arabic", "AR", "阿拉伯语 Arabic"},
        {"Turkish", "TR", "土耳其语 Turkish"},
        {"Russian", "RU", "俄语 Russian"},
        {"Spanish", "ES", "西班牙语 Spanish"},
        {"Portuguese", "PT", "葡萄牙语 Portuguese"},
        {"French", "FR", "法语 French"},
        {"German", "DE", "德语 German"},
        {"Italian", "IT", "意大利语 Italian"},
        {"Japanese", "JA", "日语 Japanese"},
        {"Korean", "KO", "韩语 Korean"},
        {"Vietnamese", "VI", "越南语 Vietnamese"},
        {"Thai", "TH", "泰语 Thai"},
        {"Filipino", "FIL", "菲律宾语 Filipino"},
    };

    public static String[] names() {
        String[] r = new String[LIST.length];
        for (int i = 0; i < LIST.length; i++) r[i] = LIST[i][0];
        return r;
    }

    public static String[] labels() {
        String[] r = new String[LIST.length];
        for (int i = 0; i < LIST.length; i++) r[i] = LIST[i][2];
        return r;
    }

    public static int indexOf(String name) {
        for (int i = 0; i < LIST.length; i++) if (LIST[i][0].equals(name)) return i;
        return -1;
    }

    public static boolean known(String name) { return indexOf(name) >= 0; }

    public static String label(String name) {
        int i = indexOf(name);
        return i >= 0 ? LIST[i][2] : (name == null ? "" : name);
    }

    public static String code(String name) {
        int i = indexOf(name);
        return i >= 0 ? LIST[i][1] : "?";
    }

    public static boolean isChinese(String name) {
        return "Simplified Chinese".equals(name) || "Traditional Chinese".equals(name);
    }

    /** 写进提示词的语言名 */
    public static String promptName(String name) {
        if ("Simplified Chinese".equals(name)) return "Simplified Chinese (简体中文)";
        if ("Traditional Chinese".equals(name)) return "Traditional Chinese (繁體中文)";
        if ("Hinglish".equals(name)) return "Hinglish (Hindi written in Latin letters, mixed with English, as Indians text)";
        return name;
    }

    /** 粗略判断：这段话是不是已经是“我的语言”了（中文判断最可靠，其他语言交给模型） */
    public static boolean looksLike(String text, String langName) {
        if (text == null) return false;
        int han = 0, kana = 0, hangul = 0, letters = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c >= 0x4E00 && c <= 0x9FFF) han++;
            else if (c >= 0x3040 && c <= 0x30FF) kana++;
            else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
            if (Character.isLetter(c)) letters++;
        }
        if (letters == 0) return true; // 纯表情 / 数字，不用翻译
        if (isChinese(langName)) return kana == 0 && han * 2 >= letters;
        if ("Japanese".equals(langName)) return kana > 0;
        if ("Korean".equals(langName)) return hangul * 2 >= letters;
        return false;
    }
}
