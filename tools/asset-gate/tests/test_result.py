from asset_gate.result import CheckResult, all_passed, format_report


def test_check_result_is_truthy_when_passed():
    r = CheckResult(check="x", passed=True, reason="ok")
    assert bool(r) is True


def test_check_result_is_falsy_when_failed():
    r = CheckResult(check="x", passed=False, reason="nope")
    assert bool(r) is False


def test_all_passed_true_when_every_result_passes():
    results = [
        CheckResult(check="a", passed=True, reason="ok"),
        CheckResult(check="b", passed=True, reason="ok"),
    ]
    assert all_passed(results) is True


def test_all_passed_false_when_any_result_fails():
    results = [
        CheckResult(check="a", passed=True, reason="ok"),
        CheckResult(check="b", passed=False, reason="nope"),
    ]
    assert all_passed(results) is False


def test_format_report_includes_status_and_reason():
    results = [
        CheckResult(check="a", passed=True, reason="all good"),
        CheckResult(check="b", passed=False, reason="broken"),
    ]
    report = format_report(results)
    assert "[PASS] a: all good" in report
    assert "[FAIL] b: broken" in report
