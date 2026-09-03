let counter = 0;

export function createId(): string {
	counter += 1;
	return `ink-${Date.now().toString(36)}-${counter}`;
}
