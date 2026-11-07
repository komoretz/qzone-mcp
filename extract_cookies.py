import os
import json
import base64
import sqlite3
import ctypes
from ctypes import wintypes
from pathlib import Path

class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(data):
    blob_in = DATA_BLOB(len(data), ctypes.create_string_buffer(data))
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        result = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return result
    raise ctypes.WinError()

class BCRYPT_AUTH_INFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.ULONG), ("dwInfoVersion", wintypes.ULONG),
        ("pbNonce", ctypes.c_void_p), ("cbNonce", wintypes.ULONG),
        ("pbAuthData", ctypes.c_void_p), ("cbAuthData", wintypes.ULONG),
        ("pbTag", ctypes.c_void_p), ("cbTag", wintypes.ULONG),
        ("pbMacContext", ctypes.c_void_p), ("cbMacContext", wintypes.ULONG),
        ("cbAAD", wintypes.ULONG), ("cbData", wintypes.ULONG),
        ("dwFlags", wintypes.ULONG),
    ]

def aes_gcm_decrypt(key, nonce, ciphertext, tag):
    bc = ctypes.windll.bcrypt
    hAlgo = ctypes.c_void_p()
    bc.BCryptOpenAlgorithmProvider(ctypes.byref(hAlgo), "AES", None, 0)
    bc.BCryptSetProperty(hAlgo, "ChainingMode", "ChainingModeGCM".encode("utf-16-le"), 32, 0)
    hKey = ctypes.c_void_p()
    keyObj = ctypes.create_string_buffer(256)
    bc.BCryptGenerateSymmetricKey(hAlgo, ctypes.byref(hKey), keyObj, 256, key, len(key), 0)
    try:
        ai = BCRYPT_AUTH_INFO()
        ctypes.memset(ctypes.byref(ai), 0, ctypes.sizeof(ai))
        ai.cbSize = ctypes.sizeof(ai)
        ai.dwInfoVersion = 1
        ai.pbNonce = ctypes.cast(nonce, ctypes.c_void_p)
        ai.cbNonce = len(nonce)
        ai.pbTag = ctypes.cast(tag, ctypes.c_void_p)
        ai.cbTag = len(tag)
        pt = ctypes.create_string_buffer(len(ciphertext))
        cbPt = wintypes.ULONG(0)
        st = bc.BCryptDecrypt(hKey, ciphertext, len(ciphertext), ctypes.byref(ai), None, 0, pt, len(ciphertext), ctypes.byref(cbPt), 0)
        if st != 0: raise Exception(f"BCryptDecrypt 失败: {st:#x}")
        return bytes(pt.raw[:cbPt.value])
    finally:
        bc.BCryptDestroyKey(hKey)
        bc.BCryptCloseAlgorithmProvider(hAlgo, 0)

def decrypt_cookie(enc, aes_key):
    if not enc: return ""
    if enc[:3] in (b"v10", b"v11"):
        try: return aes_gcm_decrypt(aes_key, enc[3:15], enc[15:-16], enc[-16:]).decode("utf-8", "replace")
        except: return ""
    try: return dpapi_decrypt(enc).decode("utf-8", "replace")
    except: return ""

def get_cookies(browser, domain):
    base = Path(os.environ["LOCALAPPDATA"])
    ud = {"edge": base/"Microsoft"/"Edge"/"User Data", "chrome": base/"Google"/"Chrome"/"User Data"}.get(browser)
    if not ud or not ud.exists(): return []
    ls = json.loads((ud/"Local State").read_text(encoding="utf-8"))
    aes_key = dpapi_decrypt(base64.b64decode(ls["os_crypt"]["encrypted_key"])[5:])
    res = []
    for p in ud.iterdir():
        if not p.is_dir(): continue
        for dbp in [p/"Network"/"Cookies", p/"Cookies"]:
            if not dbp.exists(): continue
            try:
                conn = sqlite3.connect(str(dbp))
                for h, n, e in conn.execute("SELECT host_key,name,encrypted_value FROM cookies"):
                    if domain not in h: continue
                    v = decrypt_cookie(e, aes_key)
                    if v: res.append({"domain": h, "name": n, "value": v})
                conn.close()
            except Exception:
                continue
    return res

if __name__ == "__main__":
    cd = {}
    uin = ""
    for b in ["edge", "chrome"]:
        for c in get_cookies(b, "qq.com"):
            if c["name"] in ["p_skey","p_uin","skey","uin","pt4_token","ptcz","RK","pgv_pvid"]:
                cd[c["name"]] = c["value"]
            if c["name"] == "uin": uin = c["value"].replace("o","")
        if cd.get("p_skey"): break
    if not uin: uin = cd.get("p_uin","").replace("o","")
    if not cd.get("p_skey"):
        print("未找到 p_skey，请确保已在 Edge/Chrome 中登录并访问了 QQ 空间主页")
    else:
        cfg = {"uin": uin, "cookies": cd}
        p = Path(__file__).parent/"config.json"
        p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"成功提取 Cookie！QQ 号: {uin}")
        print(f"已保存到: {p}")
