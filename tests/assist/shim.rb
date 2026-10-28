# Faux événement Logstash pour le banc des règles ruby → VRL : les mêmes get / set / remove / tag / cancel que
# LogStash::Event, sur un Hash. Lit des événements JSON (un par ligne) et le code d'un filtre ; écrit pour chacun
# {"event": …, "cancelled": …, "exception": …}.
#   ruby shim.rb code.rb événements.ndjson
require 'json'

class FauxEvent
  attr_reader :data, :cancelled
  def initialize(data) @data = data; @cancelled = false end
  def segments(ref)
    ref = ref.to_s
    ref.start_with?('[') ? ref.scan(/\[([^\]]+)\]/).flatten : [ref]
  end
  def get(ref)
    cur = @data
    segments(ref).each do |s|
      cur = case cur
            when Hash then cur[s]
            when Array then (s =~ /\A-?\d+\z/ ? cur[s.to_i] : nil)
            end
      return nil if cur.nil?
    end
    cur
  end
  def set(ref, value)
    segs = segments(ref); cur = @data
    segs[0..-2].each { |s| cur[s] = {} unless cur[s].is_a?(Hash); cur = cur[s] }
    cur[segs[-1]] = value
    value
  end
  def remove(ref)
    segs = segments(ref); cur = @data
    segs[0..-2].each { |s| cur = cur.is_a?(Hash) ? cur[s] : nil; return nil if cur.nil? }
    cur.is_a?(Hash) ? cur.delete(segs[-1]) : nil
  end
  def include?(ref) !get(ref).nil? end
  def tag(t)
    tags = get('tags'); tags = [] if tags.nil?; tags = [tags] unless tags.is_a?(Array)
    tags << t unless tags.include?(t)
    set('tags', tags)
  end
  def cancel; @cancelled = true end
end

code = File.read(ARGV[0])
File.readlines(ARGV[1]).each do |line|
  next if line.strip.empty?
  event = FauxEvent.new(JSON.parse(line)); exception = nil
  begin
    eval(code, binding)
  rescue Exception => e
    exception = e.class.to_s
    event.tag('_rubyexception')
  end
  puts JSON.generate({ 'event' => event.cancelled ? nil : event.data, 'cancelled' => event.cancelled, 'exception' => exception })
end
