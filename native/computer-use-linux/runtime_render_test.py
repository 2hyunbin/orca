import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeStateType:
    PROTECTED = 1
    SELECTED = 2
    ACTIVE = 3
    SHOWING = 4
    FOCUSED = 5


class FakeText:
    @staticmethod
    def get_character_count(node):
        return len(node.value)

    @staticmethod
    def get_text(node, start, end):
        return node.value[start:end]


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(StateType=FakeStateType, Text=FakeText)
    repository.Gdk = types.SimpleNamespace()
    repository.GdkPixbuf = types.SimpleNamespace()
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("orca_linux_runtime_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_runtime()


class FakeAccessible:
    def __init__(self, role, name="", value="", children=(), counter=None):
        self.role = role
        self.name = name
        self.value = value
        self.children = list(children)
        self.counter = counter or {"child_reads": 0}
        for child in self.children:
            child.use_counter(self.counter)

    def use_counter(self, counter):
        self.counter = counter
        for child in self.children:
            child.use_counter(counter)

    def get_child_count(self):
        self.counter["child_reads"] += 1
        return len(self.children)

    def get_child_at_index(self, index):
        self.counter["child_reads"] += 1
        return self.children[index]

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_accessible_id(self):
        return ""

    def get_toolkit_name(self):
        return "fake"

    def get_component_iface(self):
        return None

    def get_state_set(self):
        return None

    def get_n_actions(self):
        return 0

    def is_text(self):
        return bool(self.value)

    def get_text_iface(self):
        return self if self.value else None

    def get_value_iface(self):
        return None


class FailingChildrenAccessible(FakeAccessible):
    def get_child_count(self):
        self.counter["child_reads"] += 1
        raise RuntimeError("defunct node")


def render(root):
    return runtime.render_accessibility_tree(root, [0])


class RuntimeRenderTest(unittest.TestCase):
    def test_snapshot_keeps_semantics_when_child_geometry_stalls(self):
        clock = [0.0]
        timeout = [800, 15000]
        stalled = []
        calls = []
        late = FakeAccessible("button", "Continue")
        late.get_name = lambda: "" if stalled else "Continue"
        late.get_n_actions = lambda: 1
        late.get_action_name = lambda _: "click"
        root = FakeAccessible("frame", "Editor", children=[
            FakeAccessible("button", "Healthy"),
            *[FakeAccessible("button", f"Slow {i}") for i in range(4)],
            late,
        ])
        app = FakeAccessible("application", "Fixture", children=[root])
        app.get_process_id = lambda: 42
        nodes = [root, *root.children]
        for node in nodes:
            node.get_component_iface = lambda node=node: node

        def set_timeout(value, startup):
            timeout[:] = [value, startup]

        def extents(node, _):
            calls.append(node.name)
            if node.name.startswith("Slow"):
                stalled.append(node.name)
                clock[0] += (max(timeout) if timeout[1] > 0 else timeout[0]) / 1000
                raise TimeoutError("unresponsive geometry")
            return runtime.Rect(100 if node is root else 110, 200 if node is root else 220, 300, 400)

        with patch.object(runtime, "desktop_apps", return_value=iter([app])), \
             patch.object(runtime.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(runtime.Atspi, "set_timeout", side_effect=set_timeout, create=True), \
             patch.object(runtime.Atspi, "Component", types.SimpleNamespace(get_extents=extents), create=True), \
             patch.object(runtime.Atspi, "CoordType", types.SimpleNamespace(SCREEN=0), create=True):
            snapshot = runtime.make_snapshot("Fixture", False, window_index=0)

        elements = snapshot["elements"]
        self.assertEqual([item["name"] for item in elements], [node.name for node in nodes])
        self.assertEqual([item["index"] for item in elements], list(range(len(nodes))))
        self.assertEqual(elements[-1]["runtimeId"], [0, 5])
        self.assertEqual(elements[-1]["actions"], ["click"])
        self.assertEqual(snapshot["treeLines"][-1], "\t6 button Continue")
        self.assertFalse(snapshot["truncation"]["truncated"])
        self.assertEqual(snapshot["windowBounds"], runtime.Rect(100, 200, 300, 400).to_json())
        self.assertEqual(elements[1]["frame"], runtime.Rect(10, 20, 300, 400).to_json())
        self.assertTrue(all(item["frame"] is None for item in elements[2:]))
        self.assertLessEqual(clock[0], 3)
        self.assertEqual(calls.count("Editor"), 1)
        self.assertEqual(timeout, [800, 15000])

    def test_geometry_skips_insufficient_budget_and_restores_action_timeout(self):
        clock = [0.0]
        timeouts = []

        def fail():
            raise TimeoutError("unresponsive geometry")

        with patch.object(runtime.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(runtime.Atspi, "set_timeout", side_effect=lambda *args: timeouts.append(args), create=True):
            reader = runtime.GeometryReader()
            clock[0] = 2.96
            calls = []
            self.assertIsNone(reader.read(lambda: calls.append("called")))
            self.assertEqual(calls, [])
            self.assertEqual(timeouts, [])
            clock[0] = 2.9
            self.assertIsNone(reader.read(fail))
            self.assertGreaterEqual(timeouts[0][0], 50)
            self.assertLessEqual(timeouts[0][0], 100)
            self.assertEqual(timeouts[0][1], -1)
            self.assertEqual(timeouts[-1], (800, 15000))

    def test_named_non_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("button", "Save", children=[FakeAccessible("text", "unused")])

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertEqual(root.counter["child_reads"], 0)
        self.assertFalse(truncation["truncated"])

    def test_wide_labeled_controls_never_enumerate_suppressed_children(self):
        roles = (
            "button", "check box", "checkbox", "combo box", "heading", "link",
            "menu item", "page tab", "push button", "radio button",
        )
        for role in roles:
            with self.subTest(role=role):
                root = FakeAccessible(
                    role, "Save", children=[FakeAccessible("text", str(i)) for i in range(10000)]
                )

                records, lines, truncation = render(root)

                self.assertEqual([item["runtimeId"] for item in records], [[0]])
                self.assertEqual(lines, [f"0 {role} Save"])
                self.assertEqual(root.counter["child_reads"], 0)
                self.assertFalse(truncation["truncated"])

    def test_control_value_or_identifier_keeps_suppression(self):
        value_node = FakeAccessible("combo box", value="Choice", children=[FakeAccessible("text", "Child")])
        identifier_node = FakeAccessible("button", children=[FakeAccessible("text", "Child")])
        identifier_node.get_accessible_id = lambda: "save-button"
        for root, expected in (
            (value_node, "0 combo box, Value: Choice"),
            (identifier_node, "0 button save-button"),
        ):
            with self.subTest(expected=expected):
                records, lines, truncation = render(root)

                self.assertEqual(len(records), 1)
                self.assertEqual(lines, [expected])
                self.assertEqual(root.counter["child_reads"], 0)
                self.assertFalse(truncation["truncated"])

    def test_unlabeled_controls_keep_child_indices_and_depth(self):
        root = FakeAccessible("button", children=[FakeAccessible("button", "Nested")])

        records, lines, truncation = render(root)

        self.assertEqual([item["runtimeId"] for item in records], [[0], [0, 0]])
        self.assertEqual(lines, ["0 button", "\t1 button Nested"])
        self.assertEqual(root.counter["child_reads"], 2)
        self.assertFalse(truncation["truncated"])

    def test_suppressed_child_failure_keeps_control_output(self):
        root = FailingChildrenAccessible("button", "Save")

        records, lines, truncation = render(root)

        self.assertEqual([item["name"] for item in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertFalse(truncation["truncated"])
        self.assertEqual(root.counter["child_reads"], 0)

    def test_named_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("section", "Details", children=[FakeAccessible("text", "body")])

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Details", "body"])
        self.assertEqual(lines, ["0 section Details", "\t1 text body"])
        self.assertEqual(root.counter["child_reads"], 3)

    def test_unnamed_generic_node_keeps_plain_text_summary(self):
        root = FakeAccessible(
            "section",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual(len(records), 1)
        self.assertEqual(lines, ["0 section, Text: Alpha Beta"])
        self.assertEqual(root.counter["child_reads"], 13)

    def test_row_keeps_its_specific_summary_walk(self):
        root = FakeAccessible(
            "row",
            "Invoice",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice", "Alpha", "Beta"])
        self.assertEqual(lines, ["0 row Invoice, Text: Alpha Beta", "\t1 text Alpha", "\t2 text Beta"])
        self.assertEqual(root.counter["child_reads"], 10)

    def test_empty_generic_wrapper_keeps_elision_path_and_depth(self):
        root = FakeAccessible("section", children=[FakeAccessible("button", "Continue")])

        records, lines, _ = render(root)

        self.assertEqual([record["runtimeId"] for record in records], [[0, 0]])
        self.assertEqual(lines, ["0 button Continue"])

    def test_child_failure_keeps_fail_soft_row_output(self):
        root = FailingChildrenAccessible("row", "Invoice")

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice"])
        self.assertEqual(lines, ["0 row Invoice"])
        self.assertFalse(truncation["truncated"])

    def test_node_limit_keeps_exact_prefix_and_truncation(self):
        root = FakeAccessible(
            "document",
            "Results",
            children=[FakeAccessible("text", f"Item {index}") for index in range(runtime.MAX_NODES)],
        )

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_NODES)
        self.assertEqual(records[-1]["name"], f"Item {runtime.MAX_NODES - 2}")
        self.assertTrue(truncation["truncated"])
        self.assertFalse(truncation["maxDepthReached"])

    def test_depth_limit_keeps_exact_prefix_and_flag(self):
        root = FakeAccessible("document", "Depth 65")
        for depth in range(runtime.MAX_DEPTH, -1, -1):
            root = FakeAccessible("document", f"Depth {depth}", children=[root])

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_DEPTH + 1)
        self.assertEqual(records[-1]["name"], f"Depth {runtime.MAX_DEPTH}")
        self.assertTrue(truncation["truncated"])
        self.assertTrue(truncation["maxDepthReached"])


if __name__ == "__main__":
    unittest.main()
