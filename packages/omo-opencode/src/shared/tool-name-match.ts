const toolNameSeparators = new Set(["_", "-", ".", ":", "/"]);

export function matchesTrackedTool(
	tool: unknown,
	trackedNames: readonly string[],
): boolean {
	if (typeof tool !== "string") return false;

	const normalizedTool = tool.toLowerCase();
	return trackedNames.some((trackedName) => {
		const normalizedTrackedName = trackedName.toLowerCase();
		if (normalizedTool === normalizedTrackedName) return true;

		const suffixStart = normalizedTool.length - normalizedTrackedName.length;
		return (
			suffixStart > 0 &&
			normalizedTool.endsWith(normalizedTrackedName) &&
			toolNameSeparators.has(normalizedTool[suffixStart - 1])
		);
	});
}
