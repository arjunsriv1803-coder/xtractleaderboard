import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Leaderboard from './pages/Leaderboard'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Leaderboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
