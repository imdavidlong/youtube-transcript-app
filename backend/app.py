import html
import os
from urllib.parse import urlparse, parse_qs

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from youtube_transcript_api import (
    YouTubeTranscriptApi,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path='')
CORS(app)


@app.route('/')
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')


def extract_video_id(url: str):
    try:
        parsed = urlparse(url)
    except Exception:
        return None

    if parsed.netloc in ("youtu.be",):
        video_id = parsed.path.lstrip("/").split("/")[0]
        return video_id if video_id else None

    if parsed.netloc in ("www.youtube.com", "youtube.com", "m.youtube.com"):
        if parsed.path == "/watch":
            params = parse_qs(parsed.query)
            ids = params.get("v")
            return ids[0] if ids else None
        if parsed.path.startswith("/embed/"):
            parts = parsed.path.split("/")
            idx = parts.index("embed")
            if idx + 1 < len(parts) and parts[idx + 1]:
                return parts[idx + 1]
        if parsed.path.startswith("/shorts/"):
            parts = parsed.path.split("/")
            idx = parts.index("shorts")
            if idx + 1 < len(parts) and parts[idx + 1]:
                return parts[idx + 1]

    return None


def format_timestamp(seconds: float) -> str:
    total_seconds = int(seconds)
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def group_into_sentences(entries):
    sentences = []
    current_texts = []
    current_start = None
    current_length = 0
    SENTENCE_ENDINGS = ('.', '?', '!', '\u3002', '\uff1f', '\uff01')

    for i, entry in enumerate(entries):
        text = html.unescape(entry.text).strip()
        if not text:
            continue

        if current_start is None:
            current_start = entry.start

        current_texts.append(text)
        current_length += len(text)

        ends_with_punct = text.endswith(SENTENCE_ENDINGS)
        over_length = current_length > 120

        time_gap = False
        if i + 1 < len(entries):
            next_entry = entries[i + 1]
            gap = next_entry.start - (entry.start + entry.duration)
            if gap > 1.5:
                time_gap = True
        else:
            time_gap = True

        if ends_with_punct or over_length or time_gap:
            sentences.append({
                "timestamp": format_timestamp(current_start),
                "text": " ".join(current_texts),
            })
            current_texts = []
            current_start = None
            current_length = 0

    if current_texts:
        sentences.append({
            "timestamp": format_timestamp(current_start),
            "text": " ".join(current_texts),
        })

    return sentences


def fetch_transcript(video_id: str):
    api = YouTubeTranscriptApi()
    transcript_list = api.list(video_id)

    preferred_languages = ["zh", "zh-Hans", "zh-TW"]
    fallback_languages = ["en"]

    transcript = None
    is_auto_generated = False

    for lang in preferred_languages:
        try:
            transcript = transcript_list.find_manually_created_transcript([lang])
            is_auto_generated = False
            break
        except Exception:
            pass

    if transcript is None:
        for lang in preferred_languages:
            try:
                transcript = transcript_list.find_generated_transcript([lang])
                is_auto_generated = True
                break
            except Exception:
                pass

    if transcript is None:
        for lang in fallback_languages:
            try:
                transcript = transcript_list.find_manually_created_transcript([lang])
                is_auto_generated = False
                break
            except Exception:
                pass

    if transcript is None:
        for lang in fallback_languages:
            try:
                transcript = transcript_list.find_generated_transcript([lang])
                is_auto_generated = True
                break
            except Exception:
                pass

    if transcript is None:
        available = list(transcript_list)
        if not available:
            raise NoTranscriptFound(video_id, [], {})
        transcript = available[0]
        is_auto_generated = transcript.is_generated

    entries = transcript.fetch()
    segments = group_into_sentences(entries)
    plain_text = "\n".join(f"[{seg['timestamp']}] {seg['text']}" for seg in segments)

    return {
        "video_id": video_id,
        "segments": segments,
        "plain_text": plain_text,
        "language": transcript.language_code,
        "is_auto_generated": is_auto_generated,
    }


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/transcript", methods=["POST"])
def get_transcript():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()

    if not url:
        return jsonify({"success": False, "error": {"code": "INVALID_URL", "message": "缺少 url 字段。"}}), 400

    video_id = extract_video_id(url)
    if not video_id:
        return jsonify({"success": False, "error": {"code": "INVALID_URL", "message": f"无法从链接中提取 video ID：{url}"}}), 400

    try:
        data = fetch_transcript(video_id)
        return jsonify({"success": True, "data": data})
    except VideoUnavailable:
        return jsonify({"success": False, "error": {"code": "VIDEO_UNAVAILABLE", "message": "视频不可用（私密、下架或地区限制）。"}}), 404
    except TranscriptsDisabled:
        return jsonify({"success": False, "error": {"code": "TRANSCRIPT_NOT_FOUND", "message": "该视频已关闭字幕功能。"}}), 404
    except NoTranscriptFound:
        return jsonify({"success": False, "error": {"code": "TRANSCRIPT_NOT_FOUND", "message": "该视频没有可用字幕。"}}), 404
    except Exception as exc:
        return jsonify({"success": False, "error": {"code": "INTERNAL_ERROR", "message": str(exc)}}), 500


@app.route("/api/translate", methods=["POST"])
def translate():
    try:
        from deep_translator import GoogleTranslator
    except ImportError:
        return jsonify({"success": False, "error": {"code": "TRANSLATE_ERROR", "message": "请先安装：pip install deep-translator"}}), 500

    body = request.get_json(silent=True) or {}
    segments = body.get("segments", [])
    target_language = body.get("target_language", "zh-CN")

    if not segments:
        return jsonify({"success": False, "error": {"code": "TRANSLATE_ERROR", "message": "缺少 segments 字段。"}}), 400

    SEPARATOR = "|||"
    MAX_CHARS = 4500

    try:
        texts = [seg.get("text", "") for seg in segments]

        batches = []
        current_batch = []
        current_length = 0

        for text in texts:
            needed = len(text) + (len(SEPARATOR) if current_batch else 0)
            if current_batch and current_length + needed > MAX_CHARS:
                batches.append(current_batch)
                current_batch = [text]
                current_length = len(text)
            else:
                current_batch.append(text)
                current_length += needed

        if current_batch:
            batches.append(current_batch)

        translated_texts = []
        translator = GoogleTranslator(source="auto", target=target_language)

        for batch in batches:
            joined = SEPARATOR.join(batch)
            translated_joined = translator.translate(joined)
            parts = translated_joined.split(SEPARATOR)
            if len(parts) != len(batch):
                parts = [translator.translate(t) for t in batch]
            translated_texts.extend(parts)

        result_segments = [
            {
                "timestamp": seg.get("timestamp", ""),
                "text": seg.get("text", ""),
                "translated_text": (translated_texts[i] or "").strip(),
            }
            for i, seg in enumerate(segments)
        ]

        return jsonify({"success": True, "data": {"segments": result_segments}})

    except Exception as exc:
        return jsonify({"success": False, "error": {"code": "TRANSLATE_ERROR", "message": str(exc)}}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
