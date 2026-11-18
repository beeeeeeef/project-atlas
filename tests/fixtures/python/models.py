class ProblemContext:
    site: str
    title: str = ""

    def __init__(self, code: str, language: str | None = None) -> None:
        self.code = code


class Plain:
    def __init__(self, name, count: int = 0):
        pass
