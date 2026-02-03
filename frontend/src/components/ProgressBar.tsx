export function ProgressBar({ value }: { value: number }) {
    return (
        <div className="progress">
            <div className="progress-fill" style={{ width: `${value}%` }} />
        </div>
    );
}
