"""決算スケジュール確認・短信PDF一括取得アプリ(Streamlit UI)

起動: streamlit run app.py
"""

from datetime import date, timedelta

import pandas as pd
import streamlit as st

import data

st.set_page_config(page_title="決算スケジュール", page_icon="📅", layout="wide")

if "checked_codes" not in st.session_state:
    st.session_state.checked_codes = set()
if "last_result" not in st.session_state:
    st.session_state.last_result = []
if "last_out_dir" not in st.session_state:
    st.session_state.last_out_dir = None
# data_editorの編集状態はkey単位で保持されるため、全選択/全解除/データ更新の際は
# nonceを進めてkeyを変え、checked_codesから再シードさせる
if "editor_nonce" not in st.session_state:
    st.session_state.editor_nonce = 0


@st.cache_data(ttl=600, show_spinner="スケジュール読込中…")
def get_schedule():
    return data.load_or_fetch_schedule()


# --- データ読込(取得失敗時は古いキャッシュにフォールバック) ---
stale_warning = None
try:
    df, fetched_at = get_schedule()
except Exception as e:  # noqa: BLE001
    cached = data.load_cached_schedule()
    if cached is None:
        st.error(f"決算スケジュールの取得に失敗しました: {e}")
        st.stop()
    df, fetched_at = cached
    stale_warning = f"最新データの取得に失敗したため、キャッシュを表示しています({e})"

df = df.copy()
df["announce_date"] = pd.to_datetime(df["announce_date"])

# --- サイドバー: フィルタ ---
with st.sidebar:
    if st.button("🔄 データ更新", use_container_width=True):
        try:
            with st.spinner("JPXから再取得中…(時価総額の取得に数分かかることがあります)"):
                data.load_or_fetch_schedule(force=True)
            get_schedule.clear()
            st.session_state.editor_nonce += 1
            st.rerun()
        except Exception as e:  # noqa: BLE001
            st.error(f"更新に失敗しました: {e}")

    period = st.selectbox("期間", ["今日", "今週", "来週", "任意期間"], index=1)
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    if period == "今日":
        start, end = today, today
    elif period == "今週":
        start, end = monday, monday + timedelta(days=6)
    elif period == "来週":
        start, end = monday + timedelta(days=7), monday + timedelta(days=13)
    else:
        c1, c2 = st.columns(2)
        start = c1.date_input("開始", value=today)
        end = c2.date_input("終了", value=today + timedelta(days=14))

    CAP_PRESETS = {"指定なし": 0, "1000億円以上": 1000, "5000億円以上": 5000, "1兆円以上": 10000}
    cap_choice = st.selectbox("時価総額", [*CAP_PRESETS, "任意"], index=0)
    if cap_choice == "任意":
        cap_min = st.number_input("下限(億円)", min_value=0, value=0, step=100)
        cap_max = st.number_input("上限(億円、0=無制限)", min_value=0, value=0, step=100)
    else:
        cap_min, cap_max = CAP_PRESETS[cap_choice], 0
    include_nan_cap = st.checkbox("時価総額不明(—)も表示", value=True)

    market_opts = sorted(m for m in df["market"].unique() if m)
    markets = st.multiselect("市場区分", market_opts, placeholder="すべて")
    sector_opts = sorted(s for s in df["sector"].unique() if s)
    sectors = st.multiselect("業種(東証33分類)", sector_opts, placeholder="すべて")
    query = st.text_input("銘柄コード・社名検索", placeholder="例: 6146 / ディスコ")

# --- フィルタ適用 ---
f = df.copy()
ad = f["announce_date"].dt.date
f = f[(ad >= start) & (ad <= end)]
cap_ok = pd.Series(True, index=f.index)
if cap_min > 0:
    cap_ok &= f["market_cap"] >= cap_min * 1e8
if cap_max > 0:
    cap_ok &= f["market_cap"] <= cap_max * 1e8
if include_nan_cap:
    cap_ok |= f["market_cap"].isna()
f = f[cap_ok]
if markets:
    f = f[f["market"].isin(markets)]
if sectors:
    f = f[f["sector"].isin(sectors)]
if query.strip():
    q = query.strip()
    f = f[f["code"].str.contains(q, case=False) | f["name"].str.contains(q, case=False)]
f = f.sort_values(["announce_date", "code"]).reset_index(drop=True)

# --- メイン ---
st.title("📅 決算発表スケジュール")
st.caption(
    f"データ取得: {fetched_at.strftime('%m/%d %H:%M')} / "
    f"表示 {len(f)} 件({start.strftime('%m/%d')}〜{end.strftime('%m/%d')})"
    " ※発表予定日は変更されることがあります"
)
if stale_warning:
    st.warning(stale_warning)

if f.empty:
    st.info("条件に一致する銘柄がありません。期間やフィルタを変更してください。")
else:
    view = pd.DataFrame(
        {
            "選択": f["code"].isin(st.session_state.checked_codes),
            "コード": f["code"],
            "社名": f["name"],
            "発表予定日": f["announce_date"].dt.date,
            "期": f["quarter"],
            "時価総額(億円)": (f["market_cap"] / 1e8).round(0),
            "市場": f["market"],
            "業種": f["sector"],
        }
    )
    editor_key = f"editor_{st.session_state.editor_nonce}_{hash(tuple(view['コード']))}"
    edited = st.data_editor(
        view,
        key=editor_key,
        hide_index=True,
        use_container_width=True,
        height=min(600, 40 + 35 * len(view)),
        column_config={
            "選択": st.column_config.CheckboxColumn("✓", width="small"),
            "発表予定日": st.column_config.DateColumn(format="MM/DD (ddd)"),
            "時価総額(億円)": st.column_config.NumberColumn(format="localized"),
        },
        disabled=["コード", "社名", "発表予定日", "期", "時価総額(億円)", "市場", "業種"],
    )
    # チェック状態をsession_stateへ同期(表示外の銘柄のチェックは維持する)
    visible = set(view["コード"])
    checked_in_view = set(edited.loc[edited["選択"], "コード"])
    st.session_state.checked_codes = (
        st.session_state.checked_codes - visible
    ) | checked_in_view

    n_checked = len(st.session_state.checked_codes)
    c1, c2, c3, _ = st.columns([1.2, 1, 1.6, 3])
    if c1.button("全選択(表示中)"):
        st.session_state.checked_codes |= visible
        st.session_state.editor_nonce += 1
        st.rerun()
    if c2.button("全解除"):
        st.session_state.checked_codes.clear()
        st.session_state.editor_nonce += 1
        st.rerun()
    run = c3.button(f"📥 PDF取得({n_checked}件)", type="primary", disabled=n_checked == 0)

    if run:
        targets = df[df["code"].isin(st.session_state.checked_codes)].drop_duplicates(
            subset=["code"]
        )
        rows = [
            {
                "code": r.code,
                "name": r.name,
                "quarter": r.quarter,
                "announce_date": r.announce_date.date().isoformat(),
            }
            for r in targets.itertuples()
        ]
        out_dir = data.DOWNLOAD_DIR / date.today().isoformat()
        prog = st.progress(0.0, text="開始…")

        def _cb(i: int, msg: str) -> None:
            prog.progress(min(i / len(rows), 1.0), text=f"({min(i + 1, len(rows))}/{len(rows)}) {msg}")

        items = data.download_tanshin_batch(rows, out_dir, _cb)
        prog.progress(1.0, text="完了")
        st.session_state.last_result = items
        st.session_state.last_out_dir = str(out_dir)

# --- 取得結果 ---
if st.session_state.last_result:
    st.subheader("取得結果")
    res = pd.DataFrame(st.session_state.last_result)
    icons = {"success": "✅ 成功", "not_published": "⏳ 未発表", "error": "❌ 失敗"}
    counts = res["status"].value_counts()
    st.caption(
        f"✅ 成功 {counts.get('success', 0)} / ⏳ 未発表 {counts.get('not_published', 0)} / "
        f"❌ 失敗 {counts.get('error', 0)} 件 — 保存先: {st.session_state.last_out_dir}"
    )
    res_view = pd.DataFrame(
        {
            "状態": res["status"].map(icons),
            "コード": res["code"],
            "社名": res["name"],
            "開示タイトル": res["tdnet_title"],
            "ファイル": res["pdf_path"],
            "エラー": res["error"],
        }
    )
    st.dataframe(res_view, hide_index=True, use_container_width=True)
