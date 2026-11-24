"""
Controle Xbox 360 virtual para o Xbox Play (via ViGEmBus + vgamepad).

Lê estados do controle como JSON, um por linha, no stdin:
    {"buttons": ["A", "DPAD_UP"], "lt": 0.0, "rt": 1.0, "lx": 0.0, "ly": 0.0, "rx": 0.0, "ry": 0.0}

Responde no stdout, também em JSON por linha:
    {"ready": true}            controle criado
    {"error": "mensagem"}      não foi possível criar o controle

É iniciado pelo bridge.js; não precisa ser executado à mão.
Use --dry-run para testar sem ViGEmBus (só imprime o que seria aplicado).
"""
import json
import sys

BUTTON_NAMES = [
    "A", "B", "X", "Y",
    "LEFT_SHOULDER", "RIGHT_SHOULDER",
    "BACK", "START",
    "LEFT_THUMB", "RIGHT_THUMB",
    "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT",
    "GUIDE",
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def clamp(value, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(low, min(high, number))


class DryRunPad:
    def apply(self, state):
        sys.stderr.write("dry-run: %s\n" % json.dumps(state, sort_keys=True))
        sys.stderr.flush()

    def reset(self):
        self.apply({"buttons": [], "lt": 0, "rt": 0, "lx": 0, "ly": 0, "rx": 0, "ry": 0})


class ViGEmPad:
    def __init__(self):
        import vgamepad as vg  # importado aqui para dar uma mensagem clara se faltar

        self.vg = vg
        self.pad = vg.VX360Gamepad()
        self.buttons = {
            name: getattr(vg.XUSB_BUTTON, "XUSB_GAMEPAD_" + name) for name in BUTTON_NAMES
        }
        self.pressed = set()

    def apply(self, state):
        wanted = set(b for b in state.get("buttons", []) if b in self.buttons)

        for name in wanted - self.pressed:
            self.pad.press_button(button=self.buttons[name])
        for name in self.pressed - wanted:
            self.pad.release_button(button=self.buttons[name])
        self.pressed = wanted

        self.pad.left_trigger_float(value_float=clamp(state.get("lt"), 0.0, 1.0))
        self.pad.right_trigger_float(value_float=clamp(state.get("rt"), 0.0, 1.0))
        self.pad.left_joystick_float(
            x_value_float=clamp(state.get("lx"), -1.0, 1.0),
            y_value_float=clamp(state.get("ly"), -1.0, 1.0),
        )
        self.pad.right_joystick_float(
            x_value_float=clamp(state.get("rx"), -1.0, 1.0),
            y_value_float=clamp(state.get("ry"), -1.0, 1.0),
        )
        self.pad.update()

    def reset(self):
        self.pressed = set()
        self.pad.reset()
        self.pad.update()


def create_pad(dry_run):
    if dry_run:
        return DryRunPad()
    try:
        return ViGEmPad()
    except ImportError:
        emit({"error": (
            "Biblioteca 'vgamepad' não instalada. Rode: "
            "python -m pip install -r tools/gamepad-bridge/requirements.txt"
        )})
    except Exception as exc:  # driver ausente, sem permissão etc.
        emit({"error": (
            "Não foi possível criar o controle virtual (%s). "
            "Instale o driver ViGEmBus e reinicie o Windows: "
            "https://github.com/nefarius/ViGEmBus/releases" % exc
        )})
    return None


def main():
    dry_run = "--dry-run" in sys.argv
    pad = create_pad(dry_run)
    if pad is None:
        return 2

    emit({"ready": True})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                state = json.loads(line)
            except ValueError:
                continue
            if isinstance(state, dict):
                pad.apply(state)
    finally:
        # stdin fechou (bridge encerrou): garante que nenhum botão fique preso.
        try:
            pad.reset()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
