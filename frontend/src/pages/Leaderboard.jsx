import React, { useState, useEffect } from "react";
import "./Leaderboard.css";

import bgImg from "../assets/images/leaderboard/2.webp";
import goldWreathImg from "../assets/images/leaderboard/g.webp";
import silverWreathImg from "../assets/images/leaderboard/s.webp";
import bronzeWreathImg from "../assets/images/leaderboard/b.webp";
import { api, WS_URL } from "../services/api";

const ROWS_PER_TABLE = 10;
const TABLES_PER_PAGE = 2; // tables shown side by side on one page

/**
 * Sort the raw leaderboard list:
 * 1. Active teams ahead of disqualified teams.
 * 2. Highest points/score first.
 * 3. For teams with tied points, whoever reached that score first ranks higher.
 * 4. Deterministic alphabetical tie-breaker.
 */
const sortLeaderboard = (rawList) => {
    const list = Array.isArray(rawList) ? [...rawList] : [];
    list.sort((a, b) => {
        // Disqualified teams placed behind active teams
        if (Boolean(a.disqualified) !== Boolean(b.disqualified)) {
            return a.disqualified ? 1 : -1;
        }

        const rawScoreA = a.points ?? a.score;
        const rawScoreB = b.points ?? b.score;
        const scoreA = typeof rawScoreA === "number" ? rawScoreA : (rawScoreA !== undefined ? Number(rawScoreA) : 0);
        const scoreB = typeof rawScoreB === "number" ? rawScoreB : (rawScoreB !== undefined ? Number(rawScoreB) : 0);

        // 1. Highest points first
        if (scoreB !== scoreA) {
            return scoreB - scoreA;
        }

        // 2. For tied points, whoever reached that score first (earliest last correct solve)
        const tsA = a.lastSolvedAt ? new Date(a.lastSolvedAt).getTime() : null;
        const tsB = b.lastSolvedAt ? new Date(b.lastSolvedAt).getTime() : null;

        // Both have a submission time — earlier wins
        if (tsA !== null && tsB !== null) {
            if (tsA !== tsB) return tsA - tsB;
        }
        // Team with a submission ranks higher than team without any submission
        if (tsA !== null && tsB === null) return -1;
        if (tsA === null && tsB !== null) return 1;

        // 3. Alphabetical tie-breaker
        const nameA = (a.team_name || a.teamName || a.name || "").toUpperCase();
        const nameB = (b.team_name || b.teamName || b.name || "").toUpperCase();
        return nameA.localeCompare(nameB);
    });
    return list;
};

const formatLeaderboard = (rawList) => {
    const sorted = sortLeaderboard(rawList);
    // The first page is always full (placeholders fill the gaps); anything
    // past it is real data only, so the last table is as long as the data is.
    const rowCount = Math.max(ROWS_PER_TABLE * TABLES_PER_PAGE, sorted.length);
    return Array.from({ length: rowCount }, (_, index) => {
        const item = sorted[index];
        const teamScore = item ? (item.points ?? item.score) : undefined;

        return {
            rank: index + 1,
            name: item
                ? (item.team_name || item.teamName || item.name || `TEAM ${index + 1}`)
                : `TEAM ${index + 1}`,
            score: typeof teamScore === "number" ? teamScore : (teamScore !== undefined ? (Number(teamScore) || 0) : "NA")
        };
    });
};

const Leaderboard = () => {
    const [teams, setTeams] = useState(formatLeaderboard([]));
    const [page, setPage] = useState(0);
    // Set while a page change is animating: the page being left and which way we are going.
    const [slide, setSlide] = useState(null);

    // Normally cleared by the entering page's animationend; this is the safety net
    // for when that never fires (e.g. the tab is hidden mid-animation).
    useEffect(() => {
        if (!slide) return undefined;
        const timer = setTimeout(() => setSlide(null), 800);
        return () => clearTimeout(timer);
    }, [slide]);

    useEffect(() => {
        const syncScale = () => {
            const scale = Math.min(
                window.innerWidth / 1920,
                window.innerHeight / 1080
            ) * 0.85;
            document.documentElement.style.setProperty("--artboard-scale", scale);
        };

        syncScale();
        window.addEventListener("resize", syncScale);

        const fetchInitialLeaderboard = async () => {
            try {
                const result = await api.getLeaderboard();
                const rawData = result.data?.leaderboard || result.data || result.leaderboard || [];
                setTeams(formatLeaderboard(rawData));
            } catch (error) {
                console.error("Failed to load initial leaderboard:", error);
            }
        };

        fetchInitialLeaderboard();

        const socket = new WebSocket(WS_URL);

        socket.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === "leaderboard:update" || payload.type === "leaderboard:init") {
                    const freshList = payload.data?.leaderboard || payload.data || [];
                    setTeams(formatLeaderboard(freshList));
                }
            } catch (err) {
                console.error("Error parsing WebSocket message:", err);
            }
        };

        return () => {
            window.removeEventListener("resize", syncScale);
            socket.close();
        };
    }, []);

    const tables = [];
    for (let start = 0; start < teams.length; start += ROWS_PER_TABLE) {
        tables.push({ startRank: start + 1, rows: teams.slice(start, start + ROWS_PER_TABLE) });
    }
    const pages = [];
    for (let start = 0; start < tables.length; start += TABLES_PER_PAGE) {
        pages.push(tables.slice(start, start + TABLES_PER_PAGE));
    }
    // Clamped so a live update that drops teams cannot leave us on a page that no longer exists.
    const currentPage = Math.min(page, pages.length - 1);
    const hasPrev = currentPage > 0;
    const hasNext = currentPage < pages.length - 1;

    const goToPage = (target) => {
        if (slide) return; // ignore clicks until the running transition has finished
        setSlide({ from: currentPage, direction: target > currentPage ? "next" : "prev" });
        setPage(target);
    };

    const pageStateClass = (index) => {
        if (index === currentPage) return slide ? ` lb-page--enter-${slide.direction}` : "";
        if (slide && index === slide.from) return ` lb-page--leave-${slide.direction}`;
        return " lb-page--hidden";
    };

    const renderWreath = (rank) => {
        if (rank === 1) return <img src={goldWreathImg} alt="1" className="lb-wreath-img" />;
        if (rank === 2) return <img src={silverWreathImg} alt="2" className="lb-wreath-img" />;
        if (rank === 3) return <img src={bronzeWreathImg} alt="3" className="lb-wreath-img" />;
        return null;
    };

    const renderTable = (teamList, startRank) => (
        <div className="lb-table-container" key={`table-${startRank}`}>
            <table className="lb-grid-table">
                <thead>
                    <tr>
                        <th className="lb-th-teams">TEAMS</th>
                        <th className="lb-th-score">SCORE</th>
                    </tr>
                </thead>
                <tbody>
                    {teamList.map((team, index) => {
                        const rankVal = startRank + index;
                        return (
                            <tr key={`row-${rankVal}`}>
                                <td className="lb-td-team">
                                    <div className="lb-team-cell">
                                        <span className="lb-rank-badge">
                                            {rankVal <= 3 ? (
                                                <span className="lb-wreath-wrapper">
                                                    {renderWreath(rankVal)}
                                                    <span className={`lb-wreath-num lb-num-${rankVal}`}>{rankVal}</span>
                                                </span>
                                            ) : (
                                                `${rankVal}.`
                                            )}
                                        </span>
                                        <span className="lb-team-name-text" title={team.name}>
                                            {team.name}
                                        </span>
                                    </div>
                                </td>
                                <td className="lb-td-score">{team.score}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="lb-viewport-wrapper">
            <img src={bgImg} alt="Background" className="lb-full-screen-bg" />

            <div className="lb-artboard">
                <h1 className="lb-heading-title">MORNING LINE ODDS</h1>

                <div className="lb-pager">
                    {pages.length > 1 && (
                        <button
                            type="button"
                            className="lb-page-arrow lb-page-arrow--prev"
                            aria-label="Previous page"
                            disabled={!hasPrev}
                            onClick={() => goToPage(currentPage - 1)}
                        >
                            {"◀︎"}
                        </button>
                    )}

                    {/* Every page sits in the same grid cell and only the current one is
                        visible (plus the one sliding out during a page change), so the
                        area keeps the size of the fullest page. */}
                    <div className="lb-pages">
                        {pages.map((pageTables, index) => (
                            <div
                                className={`lb-tables-flex-row lb-page${pageStateClass(index)}`}
                                aria-hidden={index !== currentPage}
                                onAnimationEnd={(event) => {
                                    if (event.target === event.currentTarget && index === currentPage) setSlide(null);
                                }}
                                key={`page-${index}`}
                            >
                                {pageTables.map((table) => renderTable(table.rows, table.startRank))}
                            </div>
                        ))}
                    </div>

                    {pages.length > 1 && (
                        <button
                            type="button"
                            className="lb-page-arrow lb-page-arrow--next"
                            aria-label="Next page"
                            disabled={!hasNext}
                            onClick={() => goToPage(currentPage + 1)}
                        >
                            {"▶︎"}
                        </button>
                    )}

                    {pages.length > 1 && (
                        <span className="lb-page-indicator" aria-live="polite">
                            {currentPage + 1} / {pages.length}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Leaderboard;
