type Props = {
    eyebrow: string;
    heading: string;
    body: string;
};

export function PlaceholderPage({ eyebrow, heading, body }: Props) {
    return (
        <div className="page">
            <div className="placeholder-panel full">
                <div className="eyebrow">{eyebrow}</div>
                <h2>{heading}</h2>
                <p className="muted">{body}</p>
            </div>
        </div>
    );
}
