# Voice (optional)

Typing works out of the box. Talking needs three free tools that run on your PC; nothing you say leaves the machine
until it is text for the AI. They are big (about 1.1 GB together), so they are not in the repo.

Put them in the app's `tools/` folder (or set `AOS_TOOLS_DIR` to another folder with the same layout):

```
tools/
├── whisper/                          speech to text (whisper.cpp)
│   ├── Release/whisper-cli.exe
│   └── ggml-base.en.bin
├── piper/                            spoken answers (Piper)
│   ├── piper/piper.exe
│   └── voices/en_GB-vctk-medium.onnx (+ .onnx.json)
└── models/                           the "Hey computer" wake word (Vosk)
    └── vosk-model-small-en-us-0.15.tar.gz
```

Where to get them:

- **whisper.cpp**: the Windows release zip from https://github.com/ggml-org/whisper.cpp/releases (unzip so
  `Release/whisper-cli.exe` sits in `tools/whisper/`), and the `ggml-base.en.bin` model from
  https://huggingface.co/ggerganov/whisper.cpp.
- **Piper**: the Windows release from https://github.com/rhasspy/piper/releases (unzip so `piper/piper.exe` sits in
  `tools/piper/`), and a voice from https://huggingface.co/rhasspy/piper-voices into `tools/piper/voices/`.
- **Vosk**: `vosk-model-small-en-us-0.15.tar.gz`, from https://alphacephei.com/vosk/models (keep it as the `.tar.gz`).

Restart the app after adding them. The Connectors page, under "On this PC", shows whether each one was found.

## Changing the voice

The voice is set at the top of `electron/voice.cjs` (`VOICE`: the model file name, the speaker number for
multi-speaker voices, and the default speed). Put the new `.onnx` file in `tools/piper/voices/` and change `model`.

## Switching it off

`AGENTIC_OS_VOICE=off` turns spoken answers off. The mute and ear buttons on the assistant's card turn speaking and
the wake word off without a restart.
