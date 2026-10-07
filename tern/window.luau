--!strict
-- The window half: a palette command that shows the Agent Web UI in a Tern
-- browser picture in picture over the focused block, or focuses the one
-- already showing it. AWUI_URL overrides the address (default: the server's
-- loopback default).

local URL = tern.getenv("AWUI_URL") or "http://127.0.0.1:4783/"

local function showing(cx: WindowCx): number?
	for _, p in cx.session:panes() do
		if p.kind == "browser" and p.url ~= nil and string.sub(p.url, 1, #URL) == URL then
			return p.pane
		end
	end
	return nil
end

tern.command({
	id = "open",
	title = "Agent Web UI",
	icon = "sparkle",
	run = function(cx)
		local open = showing(cx)
		if open then
			cx.layout:focus(open)
			return
		end
		local owner = cx.session:focused()
		if owner == nil then
			cx:toast("error", "Agent Web UI", "No block to open it over")
			return
		end
		cx.browser:call({ op = "open", owner = owner, url = URL }):next(function(result, err, later)
			local problem = err or (result and result.error and result.error.message)
			if problem and later then
				later:toast("error", "Could not open the Agent Web UI", problem)
			end
		end)
	end,
})
